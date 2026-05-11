import type { Scope } from 'effect'
import { Effect, Layer, Schema } from 'effect'
import { Bridge, BridgeTransport, TransportAdapter, UrlParamMessage } from 'effect-messaging-core'
import * as fc from 'fast-check'
import { LoggingLayerTest } from 'kitchen-sink/test'
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test'
import * as WebPlatformAdapter from '../src/web-platform-adapter.ts'

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

const webTransport = <Bridges extends ReadonlyArray<Bridge.AnyBridge>>(config: {
  readonly bridges: Bridges
  readonly layers: Bridge.TransportLayers<Bridges, 'Web'>
}): Effect.Effect<BridgeTransport.BridgeTransport<Bridges, 'Web'>, never, Scope.Scope> =>
  BridgeTransport.make({
    bridges: config.bridges,
    layers: config.layers,
    side: 'Web',
  }).pipe(Effect.provide(Layer.succeed(TransportAdapter, WebPlatformAdapter.make(config.bridges))))

describe('BridgeTransport (Web) — live dispatch', () => {
  beforeEach(() => {
    clearUrlSearch()
    delete (window as WindowWithBridge).ReactNativeWebView
  })

  test('routes a live HostBackRequested to the NavigationBridge handler', async () => {
    let backCalls = 0
    const layer = NavigationBridge.Web.ReceiverLayer({
      HostBackRequested: () => Effect.sync(() => (backCalls += 1)),
      HostRequestedWebNavigation: () => Effect.void,
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const transport = yield* webTransport({
          bridges: [NavigationBridge] as const,
          layers: [layer] as const,
        })
        dispatchPostMessage(
          Schema.encodeSync(NavigationBridge.MessageSchemas.HostBackRequested)({
            _tag: 'HostBackRequested',
          })
        )
        yield* transport.flushed
        expect(backCalls).toBe(1)
      }).pipe(Effect.scoped)
    )
  })

  test('routes HostRequestedWebNavigation with its decoded payload', async () => {
    const seenPaths: string[] = []
    const layer = NavigationBridge.Web.ReceiverLayer({
      HostBackRequested: () => Effect.void,
      HostRequestedWebNavigation: ({ path }) =>
        Effect.sync(() => {
          seenPaths.push(path)
        }),
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const transport = yield* webTransport({
          bridges: [NavigationBridge] as const,
          layers: [layer] as const,
        })
        dispatchPostMessage(
          Schema.encodeSync(NavigationBridge.MessageSchemas.HostRequestedWebNavigation)({
            _tag: 'HostRequestedWebNavigation',
            path: '/gatekeeper',
          })
        )
        yield* transport.flushed
        expect(seenPaths).toEqual(['/gatekeeper'])
      }).pipe(Effect.scoped)
    )
  })

  test('ignores events from a foreign origin', async () => {
    let backCalls = 0
    const layer = NavigationBridge.Web.ReceiverLayer({
      HostBackRequested: () => Effect.sync(() => (backCalls += 1)),
      HostRequestedWebNavigation: () => Effect.void,
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const transport = yield* webTransport({
          bridges: [NavigationBridge] as const,
          layers: [layer] as const,
        })
        dispatchPostMessage(
          Schema.encodeSync(NavigationBridge.MessageSchemas.HostBackRequested)({
            _tag: 'HostBackRequested',
          }),
          'https://attacker.example'
        )
        yield* transport.flushed
        expect(backCalls).toBe(0)
      }).pipe(Effect.scoped)
    )
  })

  test('warns on unknown live tags without throwing', async () => {
    const layer = NavigationBridge.Web.ReceiverLayer({
      HostBackRequested: () => Effect.void,
      HostRequestedWebNavigation: () => Effect.void,
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const transport = yield* webTransport({
          bridges: [NavigationBridge] as const,
          layers: [layer] as const,
        })
        dispatchPostMessage(JSON.stringify({ _tag: 'NotARealTag' }))
        yield* transport.flushed
      }).pipe(
        LoggingLayerTest.expectToLog((logs) => {
          // Schema.Union folds unknown-tag into the same ParseError variant
          // as malformed payloads — both surface via the parse-error log.
          expect(logs).toEqual([
            expect.objectContaining({
              level: 'WARN',
              // oxlint-disable-next-line typescript/no-unsafe-assignment
              message: expect.stringContaining('[effect-messaging] failed to decode message:'),
            }),
          ])
        }),
        Effect.scoped
      )
    )
  })

  test('warns when a known tag fails to decode', async () => {
    const layer = NavigationBridge.Web.ReceiverLayer({
      HostBackRequested: () => Effect.void,
      HostRequestedWebNavigation: () => Effect.void,
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const transport = yield* webTransport({
          bridges: [NavigationBridge] as const,
          layers: [layer] as const,
        })
        // Tag matches but lacks the required `path` — passes envelope, fails specific decode.
        dispatchPostMessage(JSON.stringify({ _tag: 'HostRequestedWebNavigation' }))
        yield* transport.flushed
      }).pipe(
        LoggingLayerTest.expectToLog((logs) => {
          expect(logs).toEqual([
            expect.objectContaining({
              level: 'WARN',
              // oxlint-disable-next-line typescript/no-unsafe-assignment
              message: expect.stringContaining('[effect-messaging] failed to decode message:'),
            }),
          ])
        }),
        Effect.scoped
      )
    )
  })

  test('warns on malformed JSON', async () => {
    const layer = NavigationBridge.Web.ReceiverLayer({
      HostBackRequested: () => Effect.void,
      HostRequestedWebNavigation: () => Effect.void,
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const transport = yield* webTransport({
          bridges: [NavigationBridge] as const,
          layers: [layer] as const,
        })
        dispatchPostMessage('not-json')
        yield* transport.flushed
      }).pipe(
        LoggingLayerTest.expectToLog((logs) => {
          expect(logs).toEqual([
            expect.objectContaining({
              level: 'WARN',
              // oxlint-disable-next-line typescript/no-unsafe-assignment
              message: expect.stringContaining('[effect-messaging] failed to decode message:'),
            }),
          ])
        }),
        Effect.scoped
      )
    )
  })
})

describe('BridgeTransport (Web) — sendMessage', () => {
  let posts: string[]

  beforeEach(() => {
    posts = []
    ;(window as WindowWithBridge).ReactNativeWebView = {
      postMessage: (data) => {
        posts.push(data)
      },
    }
  })
  afterEach(() => {
    delete (window as WindowWithBridge).ReactNativeWebView
  })

  test('encodes and posts to ReactNativeWebView when present', async () => {
    const layer = NavigationBridge.Web.ReceiverLayer({
      HostBackRequested: () => Effect.void,
      HostRequestedWebNavigation: () => Effect.void,
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const transport = yield* webTransport({
          bridges: [NavigationBridge] as const,
          layers: [layer] as const,
        })
        yield* transport.sendMessage({ _tag: 'RouteChanged', pathname: '/x', canGoBack: true })
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
    const layer = NavigationBridge.Web.ReceiverLayer({
      HostBackRequested: () => Effect.void,
      HostRequestedWebNavigation: () => Effect.void,
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const transport = yield* webTransport({
          bridges: [NavigationBridge] as const,
          layers: [layer] as const,
        })
        yield* transport.sendMessage({ _tag: 'RouteChanged', pathname: '/x', canGoBack: false })
      }).pipe(
        LoggingLayerTest.expectToLog((logs) => {
          expect(logs).toEqual([
            {
              level: 'WARN',
              message:
                '[effect-messaging] sendMessage: no ReactNativeWebView in window; running standalone? message dropped.',
            },
          ])
        }),
        Effect.scoped
      )
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

    const layer = NavigationBridge.Web.ReceiverLayer({
      HostBackRequested: () => Effect.void,
      HostRequestedWebNavigation: ({ path: p }) =>
        Effect.sync(() => {
          seenPaths.push(p)
        }),
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const transport = yield* webTransport({
          bridges: [NavigationBridge] as const,
          layers: [layer] as const,
        })
        yield* transport.flushed
        expect(seenPaths).toEqual([path])
      }).pipe(Effect.scoped)
    )
  })

  test('strips bridge params from the URL after read so HMR does not re-dispatch', async () => {
    setInitialNavigationPath('/x')
    expect(window.location.search).toContain('HostRequestedWebNavigation')

    const layer = NavigationBridge.Web.ReceiverLayer({
      HostBackRequested: () => Effect.void,
      HostRequestedWebNavigation: () => Effect.void,
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const transport = yield* webTransport({
          bridges: [NavigationBridge] as const,
          layers: [layer] as const,
        })
        yield* transport.flushed
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
    const layer = NavigationBridge.Web.ReceiverLayer({
      HostBackRequested: () => Effect.void,
      HostRequestedWebNavigation: () => Effect.void,
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const transport = yield* webTransport({
          bridges: [NavigationBridge] as const,
          layers: [layer] as const,
        })
        yield* transport.flushed
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
    const navLayer = NavigationBridge.Web.ReceiverLayer({
      HostBackRequested: () => Effect.sync(() => (backCalls += 1)),
      HostRequestedWebNavigation: () => Effect.void,
    })
    const testLayer = TestBridge.Web.ReceiverLayer({
      Pong: () => Effect.void,
      Buzz: () => Effect.sync(() => (buzzCalls += 1)),
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const transport = yield* webTransport({
          bridges: [NavigationBridge, TestBridge] as const,
          layers: [navLayer, testLayer] as const,
        })
        dispatchPostMessage(
          Schema.encodeSync(NavigationBridge.MessageSchemas.HostBackRequested)({
            _tag: 'HostBackRequested',
          })
        )
        dispatchPostMessage(Schema.encodeSync(Buzz)({ _tag: 'Buzz' }))
        yield* transport.flushed
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
    const navLayer = NavigationBridge.Web.ReceiverLayer({
      HostBackRequested: () => Effect.void,
      HostRequestedWebNavigation: () => Effect.void,
    })
    const conflictingLayer = Conflicting.Web.ReceiverLayer({
      HostBackRequested: () => Effect.void,
    })
    const program = Effect.scoped(
      webTransport({
        bridges: [NavigationBridge, Conflicting] as const,
        layers: [navLayer, conflictingLayer] as const,
      })
    )
    await expect(Effect.runPromise(program)).rejects.toThrow(
      /duplicate inbound tag\(s\) "HostBackRequested"/
    )
  })
})

describe('BridgeTransport (Web) — type assertions (compile-only)', () => {
  test('compile-time: sendMessage rejects a tag not owned by any wired bridge', async () => {
    const layer = NavigationBridge.Web.ReceiverLayer({
      HostBackRequested: () => Effect.void,
      HostRequestedWebNavigation: () => Effect.void,
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const transport = yield* webTransport({
          bridges: [NavigationBridge] as const,
          layers: [layer] as const,
        })
        // @ts-expect-error — `Bogus` is not in NavigationBridge.Web outbound.
        yield* transport.sendMessage({ _tag: 'Bogus' })
      }).pipe(Effect.scoped)
    )
  })
})

describe('BridgeTransport (Web) — concurrency / lifecycle', () => {
  beforeEach(() => {
    ;(window as WindowWithBridge).ReactNativeWebView = {
      postMessage: () => undefined,
    }
  })

  test('handlers fire in send order under load', async () => {
    const seen: number[] = []
    const layer = NavigationBridge.Web.ReceiverLayer({
      HostBackRequested: () => Effect.void,
      HostRequestedWebNavigation: ({ path }) =>
        Effect.sync(() => {
          seen.push(Number(path))
        }),
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const transport = yield* webTransport({
          bridges: [NavigationBridge] as const,
          layers: [layer] as const,
        })
        for (let i = 0; i < 100; i++) {
          dispatchPostMessage(
            Schema.encodeSync(NavigationBridge.MessageSchemas.HostRequestedWebNavigation)({
              _tag: 'HostRequestedWebNavigation',
              path: String(i),
            })
          )
        }
        yield* transport.flushed
        expect(seen).toEqual(Array.from({ length: 100 }, (_, i) => i))
      }).pipe(Effect.scoped)
    )
  })

  test('a slow handler holds up the queue until it resolves', async () => {
    const order: string[] = []
    const layer = NavigationBridge.Web.ReceiverLayer({
      HostBackRequested: () =>
        Effect.gen(function* () {
          yield* Effect.sleep(20)
          order.push('back')
        }),
      HostRequestedWebNavigation: () =>
        Effect.sync(() => {
          order.push('nav')
        }),
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const transport = yield* webTransport({
          bridges: [NavigationBridge] as const,
          layers: [layer] as const,
        })
        dispatchPostMessage(
          Schema.encodeSync(NavigationBridge.MessageSchemas.HostBackRequested)({
            _tag: 'HostBackRequested',
          })
        )
        dispatchPostMessage(
          Schema.encodeSync(NavigationBridge.MessageSchemas.HostRequestedWebNavigation)({
            _tag: 'HostRequestedWebNavigation',
            path: '/x',
          })
        )
        yield* transport.flushed
        expect(order).toEqual(['back', 'nav'])
      }).pipe(Effect.scoped)
    )
  })

  test('a handler defect is logged but does not kill the dispatch fiber', async () => {
    let secondCalls = 0
    const layer = NavigationBridge.Web.ReceiverLayer({
      HostBackRequested: () => Effect.die('intentional defect'),
      HostRequestedWebNavigation: () => Effect.sync(() => (secondCalls += 1)),
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const transport = yield* webTransport({
          bridges: [NavigationBridge] as const,
          layers: [layer] as const,
        })
        dispatchPostMessage(
          Schema.encodeSync(NavigationBridge.MessageSchemas.HostBackRequested)({
            _tag: 'HostBackRequested',
          })
        )
        dispatchPostMessage(
          Schema.encodeSync(NavigationBridge.MessageSchemas.HostRequestedWebNavigation)({
            _tag: 'HostRequestedWebNavigation',
            path: '/after',
          })
        )
        yield* transport.flushed
        expect(secondCalls).toBe(1)
      }).pipe(
        LoggingLayerTest.expectToLog((logs) => {
          expect(logs).toEqual([
            {
              level: 'ERROR',
              message: '[effect-messaging] handler defect; dispatch continues: intentional defect',
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
    const layer = NavigationBridge.Web.ReceiverLayer({
      HostBackRequested: () =>
        Effect.gen(function* () {
          started = true
          yield* Effect.sleep(10_000)
          finished = true
        }),
      HostRequestedWebNavigation: () => Effect.void,
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const transport = yield* webTransport({
          bridges: [NavigationBridge] as const,
          layers: [layer] as const,
        })
        dispatchPostMessage(
          Schema.encodeSync(NavigationBridge.MessageSchemas.HostBackRequested)({
            _tag: 'HostBackRequested',
          })
        )
        yield* Effect.sleep(10)
        return transport
      }).pipe(Effect.scoped)
    )
    expect(started).toBe(true)
    expect(finished).toBe(false)
  })
})

test('property: receive path survives arbitrary string inputs', async () => {
  const Buzz = Schema.parseJson(Schema.TaggedStruct('Buzz', {}))
  const SmallBridge = Bridge.make({
    name: 'Small',
    hostToWeb: [['Buzz', Buzz]] as const,
    webToHost: [] as const,
  })
  const layer = SmallBridge.Web.ReceiverLayer({ Buzz: () => Effect.void })

  const wellFormed = fc.constant(JSON.stringify({ _tag: 'Buzz' }))
  const badPayload = fc.constant(JSON.stringify({ _tag: 'Buzz', extra: { unexpected: true } }))
  const unknownTag = fc
    .string({ minLength: 1, maxLength: 6 })
    .map((t) => JSON.stringify({ _tag: t }))
  const malformedJson = fc.string()
  const inputArb = fc.oneof(wellFormed, badPayload, unknownTag, malformedJson)

  await fc.assert(
    fc.asyncProperty(fc.array(inputArb, { maxLength: 30 }), async (inputs) => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const transport = yield* webTransport({
            bridges: [SmallBridge] as const,
            layers: [layer] as const,
          })
          for (const raw of inputs) dispatchPostMessage(raw)
          yield* transport.flushed
        }).pipe(Effect.scoped)
      )
    }),
    { numRuns: 25 }
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
      ;(window as WindowWithBridge).ReactNativeWebView = {
        postMessage: (data) => {
          posts.push(data)
        },
      }
      const aLayer = BridgeA.Web.ReceiverLayer({})
      const bLayer = BridgeB.Web.ReceiverLayer({})
      await Effect.runPromise(
        Effect.gen(function* () {
          const transport = yield* webTransport({
            bridges: [BridgeA, BridgeB] as const,
            layers: [aLayer, bLayer] as const,
          })
          for (const step of steps) {
            if (step._tag === 'Alpha') yield* transport.sendMessage(step)
            else yield* transport.sendMessage(step)
          }
          expect(posts).toHaveLength(steps.length)
          for (let i = 0; i < steps.length; i++) {
            const decoded: unknown = JSON.parse(posts[i] ?? '')
            expect(decoded).toEqual(steps[i])
          }
        }).pipe(Effect.scoped)
      )
      delete (window as WindowWithBridge).ReactNativeWebView
    })
  )
})
