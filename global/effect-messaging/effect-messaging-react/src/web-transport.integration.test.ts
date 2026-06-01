import type { Scope } from 'effect'
import { Effect, Layer, Logger, Queue, Schema } from 'effect'
import {
  Bridge,
  BridgeTransport,
  type MessageHandler,
  TransportAdapter,
  UrlParamMessage,
} from 'effect-messaging-core'
import * as fc from 'fast-check'
import { LoggingLayerTest, numRunsFor } from 'kitchen-sink/test'
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test'
import * as WebPlatformAdapter from './web-platform-adapter.ts'

type WindowWithBridge = Window & {
  ReactNativeWebView?: { postMessage(data: string): void }
}

const dispatchPostMessage = (raw: string, origin: string = window.location.origin): void => {
  const event = new MessageEvent('message', { data: raw, origin, source: window })
  window.dispatchEvent(event)
}

const clearUrlSearch = (): void => {
  const url = new URL(window.location.href)
  url.search = ''
  window.history.replaceState({}, '', url.toString())
}

// Test fixture — the package can't import slice contracts.
const HostBackRequested = Schema.parseJson(Schema.TaggedStruct('HostBackRequested', {}))
const HostRequestedWebNavigation = Schema.parseJson(
  Schema.TaggedStruct('HostRequestedWebNavigation', { path: Schema.String })
)
const RouteChanged = Schema.parseJson(
  Schema.TaggedStruct('RouteChanged', { pathname: Schema.String, canGoBack: Schema.Boolean })
)
const NavigationBridge = Bridge.make({
  name: 'Navigation',
  hostToWeb: [
    ['HostBackRequested', HostBackRequested],
    ['HostRequestedWebNavigation', HostRequestedWebNavigation],
  ] as const,
  webToHost: [['RouteChanged', RouteChanged]] as const,
  urlParams: {
    HostRequestedWebNavigation: UrlParamMessage.singleStringMessageSchema(
      'HostRequestedWebNavigation',
      'path'
    ),
  },
})

const setInitialNavigationPath = (path: string): void => {
  const url = new URL(window.location.href)
  const next = UrlParamMessage.appendMessagesToUrl(
    url,
    [NavigationBridge],
    [{ _tag: 'HostRequestedWebNavigation', path }]
  )
  window.history.replaceState({}, '', next.toString())
}

/** No-op handler record for the NavigationBridge web side. */
const navNoopHandlers = (): MessageHandler.HandlersFor<(typeof NavigationBridge)['HostToWeb']> => ({
  HostBackRequested: () => Effect.void,
  HostRequestedWebNavigation: () => Effect.void,
})

/**
 * Wire the Web transport over the real {@link WebPlatformAdapter}, taking
 * plain per-bridge handler records (the post-Layers surface).
 */
const webTransport = <Bridges extends ReadonlyArray<Bridge.AnyBridge>>(config: {
  readonly bridges: Bridges
  readonly handlers: Bridge.HandlersByBridge<Bridges, 'HostToWeb'>
}): Effect.Effect<
  BridgeTransport.BridgeTransport<Bridges, 'HostToWeb', 'WebToHost'>,
  never,
  Scope.Scope
> =>
  BridgeTransport.makeWebTransport({
    bridges: config.bridges,
    handlers: config.handlers,
  }).pipe(Effect.provide(Layer.succeed(TransportAdapter, WebPlatformAdapter.make(config.bridges))))

/**
 * A `Logger.replace` layer paired with a queue of captured entries.
 *
 * @remarks
 * Inbound decode warnings and outbound send warnings are emitted by the
 * transport's forked dispatch/pump fibers — there is no synchronous
 * return value to await on. `Queue.take(logQueue)` blocks until the fiber
 * actually logs, so the assertion can't race the fiber. The fibers
 * inherit this replaced logger from the FiberRef captured at fork time
 * (the layer is provided around the whole program), so their logs land
 * here rather than on the console.
 */
const makeLogQueue = (): {
  readonly layer: Layer.Layer<never>
  readonly logQueue: Queue.Queue<{ readonly level: string; readonly message: string }>
} => {
  const logQueue = Effect.runSync(
    Queue.unbounded<{ readonly level: string; readonly message: string }>()
  )
  const layer = Logger.replace(
    Logger.defaultLogger,
    Logger.make(({ logLevel, message }) => {
      Effect.runSync(Queue.offer(logQueue, { level: logLevel.label, message: String(message) }))
    })
  )
  return { layer, logQueue }
}

describe('BridgeTransport (Web) — live dispatch', () => {
  beforeEach(() => {
    clearUrlSearch()
    delete (window as WindowWithBridge).ReactNativeWebView
  })

  test('routes a live HostBackRequested to the NavigationBridge handler', async () => {
    let backCalls = 0
    await Effect.runPromise(
      Effect.gen(function* () {
        const ran = yield* Queue.unbounded<void>()
        yield* webTransport({
          bridges: [NavigationBridge] as const,
          handlers: [
            {
              HostBackRequested: () =>
                Effect.gen(function* () {
                  backCalls += 1
                  yield* Queue.offer(ran, undefined)
                }),
              HostRequestedWebNavigation: () => Effect.void,
            },
          ],
        })
        dispatchPostMessage(
          Schema.encodeSync(NavigationBridge.HostToWeb.HostBackRequested)({
            _tag: 'HostBackRequested',
          })
        )
        // Blocks until the handler fiber has actually run.
        yield* Queue.take(ran)
        expect(backCalls).toBe(1)
      }).pipe(Effect.scoped)
    )
  })

  test('routes HostRequestedWebNavigation with its decoded payload', async () => {
    const seenPaths: string[] = []
    await Effect.runPromise(
      Effect.gen(function* () {
        const ran = yield* Queue.unbounded<void>()
        yield* webTransport({
          bridges: [NavigationBridge] as const,
          handlers: [
            {
              HostBackRequested: () => Effect.void,
              HostRequestedWebNavigation: ({ path }) =>
                Effect.gen(function* () {
                  seenPaths.push(path)
                  yield* Queue.offer(ran, undefined)
                }),
            },
          ],
        })
        dispatchPostMessage(
          Schema.encodeSync(NavigationBridge.HostToWeb.HostRequestedWebNavigation)({
            _tag: 'HostRequestedWebNavigation',
            path: '/gatekeeper',
          })
        )
        yield* Queue.take(ran)
        expect(seenPaths).toEqual(['/gatekeeper'])
      }).pipe(Effect.scoped)
    )
  })

  test('ignores events from a foreign origin', async () => {
    let backCalls = 0
    await Effect.runPromise(
      Effect.gen(function* () {
        const sentinel = yield* Queue.unbounded<void>()
        yield* webTransport({
          bridges: [NavigationBridge] as const,
          handlers: [
            {
              HostBackRequested: () => Effect.sync(() => (backCalls += 1)),
              // A same-origin sentinel: once it dispatches, the foreign
              // event ahead of it has already been filtered (or not) — so
              // `backCalls` is settled when the sentinel's handler runs.
              HostRequestedWebNavigation: () =>
                Queue.offer(sentinel, undefined).pipe(Effect.asVoid),
            },
          ],
        })
        dispatchPostMessage(
          Schema.encodeSync(NavigationBridge.HostToWeb.HostBackRequested)({
            _tag: 'HostBackRequested',
          }),
          'https://attacker.example'
        )
        dispatchPostMessage(
          Schema.encodeSync(NavigationBridge.HostToWeb.HostRequestedWebNavigation)({
            _tag: 'HostRequestedWebNavigation',
            path: '/sentinel',
          })
        )
        yield* Queue.take(sentinel)
        expect(backCalls).toBe(0)
      }).pipe(Effect.scoped)
    )
  })

  test('warns on unknown live tags without throwing', async () => {
    const { layer, logQueue } = makeLogQueue()
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* webTransport({ bridges: [NavigationBridge] as const, handlers: [navNoopHandlers()] })
        dispatchPostMessage(JSON.stringify({ _tag: 'NotARealTag' }))
        // Schema.Union folds unknown-tag into the same ParseError variant
        // as malformed payloads — both surface via the parse-error log.
        const logged = yield* Queue.take(logQueue)
        expect(logged.level).toBe('WARN')
        expect(logged.message).toContain('[effect-messaging] failed to decode message:')
      }).pipe(Effect.provide(layer), Effect.scoped)
    )
  })

  test('warns when a known tag fails to decode', async () => {
    const { layer, logQueue } = makeLogQueue()
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* webTransport({ bridges: [NavigationBridge] as const, handlers: [navNoopHandlers()] })
        // Tag matches but lacks the required `path` — passes envelope, fails specific decode.
        dispatchPostMessage(JSON.stringify({ _tag: 'HostRequestedWebNavigation' }))
        const logged = yield* Queue.take(logQueue)
        expect(logged.level).toBe('WARN')
        expect(logged.message).toContain('[effect-messaging] failed to decode message:')
      }).pipe(Effect.provide(layer), Effect.scoped)
    )
  })

  test('warns on malformed JSON', async () => {
    const { layer, logQueue } = makeLogQueue()
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* webTransport({ bridges: [NavigationBridge] as const, handlers: [navNoopHandlers()] })
        dispatchPostMessage('not-json')
        const logged = yield* Queue.take(logQueue)
        expect(logged.level).toBe('WARN')
        expect(logged.message).toContain('[effect-messaging] failed to decode message:')
      }).pipe(Effect.provide(layer), Effect.scoped)
    )
  })
})

describe('BridgeTransport (Web) — sendMessage', () => {
  afterEach(() => {
    delete (window as WindowWithBridge).ReactNativeWebView
  })

  test('encodes and posts to ReactNativeWebView when present', async () => {
    const posts: string[] = []
    await Effect.runPromise(
      Effect.gen(function* () {
        const ran = yield* Queue.unbounded<void>()
        ;(window as WindowWithBridge).ReactNativeWebView = {
          postMessage: (data) => {
            posts.push(data)
            Effect.runSync(Queue.offer(ran, undefined))
          },
        }
        const transport = yield* webTransport({
          bridges: [NavigationBridge] as const,
          handlers: [navNoopHandlers()],
        })
        yield* transport.sendMessage({ _tag: 'RouteChanged', pathname: '/x', canGoBack: true })
        // The outbox pump flushes on a fiber; block until the post lands.
        yield* Queue.take(ran)
        expect(posts).toHaveLength(1)
        expect(JSON.parse(posts[0] ?? '')).toEqual({
          _tag: 'RouteChanged',
          pathname: '/x',
          canGoBack: true,
        })
      }).pipe(Effect.scoped)
    )
  })

  test('warns and drops when ReactNativeWebView is absent (standalone web)', async () => {
    delete (window as WindowWithBridge).ReactNativeWebView
    const { layer, logQueue } = makeLogQueue()
    await Effect.runPromise(
      Effect.gen(function* () {
        const transport = yield* webTransport({
          bridges: [NavigationBridge] as const,
          handlers: [navNoopHandlers()],
        })
        yield* transport.sendMessage({ _tag: 'RouteChanged', pathname: '/x', canGoBack: false })
        const logged = yield* Queue.take(logQueue)
        expect(logged).toEqual({
          level: 'WARN',
          message:
            '[effect-messaging] sendMessage: no ReactNativeWebView in window; running standalone? message dropped.',
        })
      }).pipe(Effect.provide(layer), Effect.scoped)
    )
  })
})

describe('BridgeTransport (Web) — URL-param initial messages', () => {
  beforeEach(() => {
    clearUrlSearch()
  })
  afterEach(() => {
    clearUrlSearch()
  })

  test('decodes ?<Tag>=<value> params and dispatches them through the queue', async () => {
    const seenPaths: string[] = []
    const path = '/gatekeeper/oauth-consent/abc'
    setInitialNavigationPath(path)

    await Effect.runPromise(
      Effect.gen(function* () {
        const ran = yield* Queue.unbounded<void>()
        yield* webTransport({
          bridges: [NavigationBridge] as const,
          handlers: [
            {
              HostBackRequested: () => Effect.void,
              HostRequestedWebNavigation: ({ path: p }) =>
                Effect.gen(function* () {
                  seenPaths.push(p)
                  yield* Queue.offer(ran, undefined)
                }),
            },
          ],
        })
        // The drained initial message dispatches on the fiber; await it.
        yield* Queue.take(ran)
        expect(seenPaths).toEqual([path])
      }).pipe(Effect.scoped)
    )
  })

  test('strips bridge params from the URL after read so HMR does not re-dispatch', async () => {
    setInitialNavigationPath('/x')
    expect(window.location.search).toContain('HostRequestedWebNavigation')

    await Effect.runPromise(
      Effect.gen(function* () {
        // `drainInitial` strips the params synchronously during `make`,
        // so the URL is already clean once the transport resolves.
        yield* webTransport({ bridges: [NavigationBridge] as const, handlers: [navNoopHandlers()] })
        expect(window.location.search).not.toContain('HostRequestedWebNavigation')
      }).pipe(Effect.scoped)
    )
  })

  test('preserves non-bridge URL params untouched', async () => {
    const url = new URL(window.location.href)
    url.search = ''
    url.searchParams.append('keep', 'me')
    window.history.replaceState({}, '', url.toString())
    setInitialNavigationPath('/anything')
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* webTransport({ bridges: [NavigationBridge] as const, handlers: [navNoopHandlers()] })
      }).pipe(Effect.scoped)
    )
    expect(new URL(window.location.href).searchParams.get('keep')).toBe('me')
    expect(window.location.search).not.toContain('HostRequestedWebNavigation')
  })
})

describe('BridgeTransport (Web) — multi-bridge composition', () => {
  beforeEach(() => {
    clearUrlSearch()
  })

  test('routes inbound messages to the correct bridge by tag', async () => {
    const Pong = Schema.parseJson(Schema.TaggedStruct('Pong', { reply: Schema.String }))
    const Buzz = Schema.parseJson(Schema.TaggedStruct('Buzz', {}))
    const TestBridge = Bridge.make({
      name: 'Test',
      hostToWeb: [
        ['Pong', Pong],
        ['Buzz', Buzz],
      ] as const,
      webToHost: [] as const,
    })

    let backCalls = 0
    let buzzCalls = 0
    await Effect.runPromise(
      Effect.gen(function* () {
        const ran = yield* Queue.unbounded<void>()
        yield* webTransport({
          bridges: [NavigationBridge, TestBridge] as const,
          handlers: [
            {
              HostBackRequested: () =>
                Effect.gen(function* () {
                  backCalls += 1
                  yield* Queue.offer(ran, undefined)
                }),
              HostRequestedWebNavigation: () => Effect.void,
            },
            {
              Pong: () => Effect.void,
              Buzz: () =>
                Effect.gen(function* () {
                  buzzCalls += 1
                  yield* Queue.offer(ran, undefined)
                }),
            },
          ],
        })
        dispatchPostMessage(
          Schema.encodeSync(NavigationBridge.HostToWeb.HostBackRequested)({
            _tag: 'HostBackRequested',
          })
        )
        dispatchPostMessage(Schema.encodeSync(Buzz)({ _tag: 'Buzz' }))
        yield* Queue.takeN(ran, 2)
        expect(backCalls).toBe(1)
        expect(buzzCalls).toBe(1)
      }).pipe(Effect.scoped)
    )
  })

  test('throws when two bridges declare overlapping inbound tags', async () => {
    const ConflictingBackRequested = Schema.parseJson(Schema.TaggedStruct('HostBackRequested', {}))
    const Conflicting = Bridge.make({
      name: 'Conflicting',
      hostToWeb: [['HostBackRequested', ConflictingBackRequested]] as const,
      webToHost: [] as const,
    })
    const program = Effect.scoped(
      webTransport({
        bridges: [NavigationBridge, Conflicting] as const,
        handlers: [navNoopHandlers(), { HostBackRequested: () => Effect.void }],
      })
    )
    await expect(Effect.runPromise(program)).rejects.toThrow(
      /duplicate inbound tag\(s\) "HostBackRequested"/
    )
  })
})

describe('BridgeTransport (Web) — type assertions (compile-only)', () => {
  test('compile-time: sendMessage rejects a tag not owned by any wired bridge', async () => {
    const { layer, logQueue } = makeLogQueue()
    await Effect.runPromise(
      Effect.gen(function* () {
        const transport = yield* webTransport({
          bridges: [NavigationBridge] as const,
          handlers: [navNoopHandlers()],
        })
        // @ts-expect-error — `Bogus` is not in NavigationBridge.WebToHost (web outbound).
        yield* transport.sendMessage({ _tag: 'Bogus' })
        const logged = yield* Queue.take(logQueue)
        expect(logged).toEqual({
          level: 'WARN',
          message: '[effect-messaging] sendMessage: no bridge owns tag "Bogus"; dropping',
        })
      }).pipe(Effect.provide(layer), Effect.scoped)
    )
  })
})

describe('BridgeTransport (Web) — concurrency / lifecycle', () => {
  beforeEach(() => {
    clearUrlSearch()
    ;(window as WindowWithBridge).ReactNativeWebView = {
      postMessage: () => undefined,
    }
  })

  test('handlers fire in send order under load', async () => {
    const seen: number[] = []
    await Effect.runPromise(
      Effect.gen(function* () {
        const ran = yield* Queue.unbounded<void>()
        yield* webTransport({
          bridges: [NavigationBridge] as const,
          handlers: [
            {
              HostBackRequested: () => Effect.void,
              HostRequestedWebNavigation: ({ path }) =>
                Effect.gen(function* () {
                  seen.push(Number(path))
                  yield* Queue.offer(ran, undefined)
                }),
            },
          ],
        })
        for (let i = 0; i < 100; i++) {
          dispatchPostMessage(
            Schema.encodeSync(NavigationBridge.HostToWeb.HostRequestedWebNavigation)({
              _tag: 'HostRequestedWebNavigation',
              path: String(i),
            })
          )
        }
        // The single dispatch fiber drains FIFO; awaiting all 100 proves order.
        yield* Queue.takeN(ran, 100)
        expect(seen).toEqual(Array.from({ length: 100 }, (_, i) => i))
      }).pipe(Effect.scoped)
    )
  })

  test('a slow handler holds up the queue until it resolves', async () => {
    const order: string[] = []
    await Effect.runPromise(
      Effect.gen(function* () {
        const ran = yield* Queue.unbounded<void>()
        yield* webTransport({
          bridges: [NavigationBridge] as const,
          handlers: [
            {
              HostBackRequested: () =>
                Effect.gen(function* () {
                  yield* Effect.sleep(20)
                  order.push('back')
                  yield* Queue.offer(ran, undefined)
                }),
              HostRequestedWebNavigation: () =>
                Effect.gen(function* () {
                  order.push('nav')
                  yield* Queue.offer(ran, undefined)
                }),
            },
          ],
        })
        dispatchPostMessage(
          Schema.encodeSync(NavigationBridge.HostToWeb.HostBackRequested)({
            _tag: 'HostBackRequested',
          })
        )
        dispatchPostMessage(
          Schema.encodeSync(NavigationBridge.HostToWeb.HostRequestedWebNavigation)({
            _tag: 'HostRequestedWebNavigation',
            path: '/x',
          })
        )
        yield* Queue.takeN(ran, 2)
        expect(order).toEqual(['back', 'nav'])
      }).pipe(Effect.scoped)
    )
  })

  test('a handler defect is logged but does not kill the dispatch fiber', async () => {
    let secondCalls = 0
    await Effect.runPromise(
      Effect.gen(function* () {
        const ran = yield* Queue.unbounded<void>()
        yield* webTransport({
          bridges: [NavigationBridge] as const,
          handlers: [
            {
              HostBackRequested: () => Effect.die('intentional defect'),
              HostRequestedWebNavigation: () =>
                Effect.gen(function* () {
                  secondCalls += 1
                  yield* Queue.offer(ran, undefined)
                }),
            },
          ],
        })
        dispatchPostMessage(
          Schema.encodeSync(NavigationBridge.HostToWeb.HostBackRequested)({
            _tag: 'HostBackRequested',
          })
        )
        dispatchPostMessage(
          Schema.encodeSync(NavigationBridge.HostToWeb.HostRequestedWebNavigation)({
            _tag: 'HostRequestedWebNavigation',
            path: '/after',
          })
        )
        // The second message dispatches only if the defect didn't take the
        // fiber down; the defect is logged ahead of it (FIFO).
        yield* Queue.take(ran)
        expect(secondCalls).toBe(1)
      }).pipe(
        LoggingLayerTest.expectToLog((logs) => {
          expect(logs).toEqual([
            {
              level: 'ERROR',
              message: '[effect-messaging] dispatch defect; continues: intentional defect',
            },
          ])
        }),
        Effect.scoped
      )
    )
  })

  test('scope close interrupts an in-flight handler', async () => {
    let started = false
    let finished = false
    const startedSignal = Effect.runSync(Queue.unbounded<void>())
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* webTransport({
          bridges: [NavigationBridge] as const,
          handlers: [
            {
              HostBackRequested: () =>
                Effect.gen(function* () {
                  started = true
                  yield* Queue.offer(startedSignal, undefined)
                  yield* Effect.sleep(10_000)
                  finished = true
                }),
              HostRequestedWebNavigation: () => Effect.void,
            },
          ],
        })
        dispatchPostMessage(
          Schema.encodeSync(NavigationBridge.HostToWeb.HostBackRequested)({
            _tag: 'HostBackRequested',
          })
        )
        // Return (closing the scope) only once the handler is mid-flight.
        yield* Queue.take(startedSignal)
      }).pipe(Effect.scoped)
    )
    expect(started).toBe(true)
    expect(finished).toBe(false)
  })
})

test('property: receive path survives arbitrary string inputs', async () => {
  const Buzz = Schema.parseJson(Schema.TaggedStruct('Buzz', {}))
  const Sentinel = Schema.parseJson(Schema.TaggedStruct('Sentinel', {}))
  const SmallBridge = Bridge.make({
    name: 'Small',
    hostToWeb: [
      ['Buzz', Buzz],
      ['Sentinel', Sentinel],
    ] as const,
    webToHost: [] as const,
  })

  const wellFormed = fc.constant(JSON.stringify({ _tag: 'Buzz' }))
  const badPayload = fc.constant(JSON.stringify({ _tag: 'Buzz', extra: { unexpected: true } }))
  const unknownTag = fc
    .string({ minLength: 1, maxLength: 6 })
    .map((t) => JSON.stringify({ _tag: t }))
  const malformedJson = fc.string()
  const inputArb = fc.oneof(wellFormed, badPayload, unknownTag, malformedJson)

  await fc.assert(
    fc.asyncProperty(fc.array(inputArb, { maxLength: 30 }), async (inputs) => {
      clearUrlSearch()
      await Effect.runPromise(
        Effect.gen(function* () {
          const done = yield* Queue.unbounded<void>()
          yield* webTransport({
            bridges: [SmallBridge] as const,
            handlers: [
              {
                Buzz: () => Effect.void,
                Sentinel: () => Queue.offer(done, undefined).pipe(Effect.asVoid),
              },
            ],
          })
          for (const raw of inputs) dispatchPostMessage(raw)
          // The Sentinel is a known tag (maxLength 6 can't collide with it),
          // so it never appears among `inputs`; FIFO guarantees every input
          // ahead of it has been processed when its handler runs.
          dispatchPostMessage(Schema.encodeSync(Sentinel)({ _tag: 'Sentinel' }))
          yield* Queue.take(done)
        }).pipe(Effect.provide(LoggingLayerTest.make().layer), Effect.scoped)
      )
    }),
    { numRuns: numRunsFor({ base: 25 }) }
  )
})

test('property: sendMessage routes to the correct bridge for arbitrary message sequences', async () => {
  const Alpha = Schema.parseJson(Schema.TaggedStruct('Alpha', { x: Schema.Number }))
  const Beta = Schema.parseJson(Schema.TaggedStruct('Beta', { y: Schema.String }))
  const BridgeA = Bridge.make({
    name: 'A',
    hostToWeb: [] as const,
    webToHost: [['Alpha', Alpha]] as const,
  })
  const BridgeB = Bridge.make({
    name: 'B',
    hostToWeb: [] as const,
    webToHost: [['Beta', Beta]] as const,
  })
  type AlphaMsg = { readonly _tag: 'Alpha'; readonly x: number }
  type BetaMsg = { readonly _tag: 'Beta'; readonly y: string }
  type Step = AlphaMsg | BetaMsg
  const stepArb: fc.Arbitrary<Step> = fc.oneof(
    fc.integer().map((x: number): Step => ({ _tag: 'Alpha', x })),
    fc.string().map((y: string): Step => ({ _tag: 'Beta', y }))
  )
  await fc.assert(
    fc.asyncProperty(fc.array(stepArb, { maxLength: 30 }), async (steps: ReadonlyArray<Step>) => {
      const posts: string[] = []
      const ran = Effect.runSync(Queue.unbounded<void>())
      ;(window as WindowWithBridge).ReactNativeWebView = {
        postMessage: (data) => {
          posts.push(data)
          Effect.runSync(Queue.offer(ran, undefined))
        },
      }
      await Effect.runPromise(
        Effect.gen(function* () {
          const transport = yield* webTransport({
            bridges: [BridgeA, BridgeB] as const,
            handlers: [{}, {}],
          })
          for (const step of steps) yield* transport.sendMessage(step)
          // Block until every send has flushed through the outbox pump.
          yield* Queue.takeN(ran, steps.length)
          expect(posts).toHaveLength(steps.length)
          for (let i = 0; i < steps.length; i++) {
            const decoded: unknown = JSON.parse(posts[i] ?? '')
            expect(decoded).toEqual(steps[i])
          }
        }).pipe(Effect.scoped)
      )
      delete (window as WindowWithBridge).ReactNativeWebView
    }),
    { numRuns: numRunsFor({ base: 100 }) }
  )
})
