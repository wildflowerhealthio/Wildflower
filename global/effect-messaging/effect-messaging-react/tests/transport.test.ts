import { Effect, Layer, Schema } from 'effect'
import { Bridge, BridgeTransport, PlatformAdapter } from 'effect-messaging-core'
import * as fc from 'fast-check'
import { LoggingLayerTest } from 'kitchen-sink/test'
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test'
import * as WebPlatformAdapter from '../src/web-platform-adapter.ts'

type WindowWithBridge = Window & {
  __INITIAL_MESSAGES__?: ReadonlyArray<string>
  ReactNativeWebView?: { postMessage(data: string): void }
}

const dispatchPostMessage = (raw: string, origin: string = window.location.origin): void => {
  const event = new MessageEvent('message', { data: raw, origin, source: window })
  window.dispatchEvent(event)
}

// In-test fixture matching the shape of the wildflower NavigationBridge.
// Effect-messaging packages must not import slice contracts; this
// fixture stays in the test file. The generic test value covers the
// patterns those contracts depend on (host-to-web tags, web-to-host
// tags, `_tag`-discriminated payloads).
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
  hostOptionsShape: Schema.Struct({}),
  webOptionsShape: Schema.Struct({}),
})

// Using the live web adapter — the page-side production wiring. The
// inferred return type matches `BridgeTransport.make` minus the
// `PlatformAdapter` requirement (which we provide via Layer here).
// oxlint-disable-next-line typescript-eslint/explicit-function-return-type
const webTransport = <Bridges extends ReadonlyArray<Bridge.AnyBridge>>(config: {
  readonly bridges: Bridges
  readonly layers: Bridge.TransportLayers<Bridges, 'Web'>
}) =>
  BridgeTransport.make({
    bridges: config.bridges,
    layers: config.layers,
    side: 'Web',
  }).pipe(Effect.provide(Layer.succeed(PlatformAdapter, WebPlatformAdapter.make())))

describe('BridgeTransport (Web) — live dispatch', () => {
  beforeEach(() => {
    delete (window as WindowWithBridge).__INITIAL_MESSAGES__
    delete (window as WindowWithBridge).ReactNativeWebView
  })

  test('routes a live HostBackRequested to the NavigationBridge handler', async () => {
    let backCalls = 0
    const layer = NavigationBridge.Web.ReceiverLayer({
      HostBackRequested: () => Effect.sync(() => (backCalls += 1)),
      HostRequestedWebNavigation: () => Effect.void,
    })
    const { promise } = LoggingLayerTest.runScoped(
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
      })
    )
    await promise
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
    const { promise } = LoggingLayerTest.runScoped(
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
      })
    )
    await promise
  })

  test('ignores events from a foreign origin', async () => {
    let backCalls = 0
    const layer = NavigationBridge.Web.ReceiverLayer({
      HostBackRequested: () => Effect.sync(() => (backCalls += 1)),
      HostRequestedWebNavigation: () => Effect.void,
    })
    const { promise } = LoggingLayerTest.runScoped(
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
      })
    )
    await promise
  })

  test('warns on unknown live tags without throwing', async () => {
    const layer = NavigationBridge.Web.ReceiverLayer({
      HostBackRequested: () => Effect.void,
      HostRequestedWebNavigation: () => Effect.void,
    })
    const { promise, logSink } = LoggingLayerTest.runScoped(
      Effect.gen(function* () {
        const transport = yield* webTransport({
          bridges: [NavigationBridge] as const,
          layers: [layer] as const,
        })
        dispatchPostMessage(JSON.stringify({ _tag: 'NotARealTag' }))
        yield* transport.flushed
      })
    )
    await promise
    LoggingLayerTest.expectWarningContaining(logSink, 'unknown live message tag: "NotARealTag"')
  })

  test('warns when a known tag fails to decode', async () => {
    const layer = NavigationBridge.Web.ReceiverLayer({
      HostBackRequested: () => Effect.void,
      HostRequestedWebNavigation: () => Effect.void,
    })
    const { promise, logSink } = LoggingLayerTest.runScoped(
      Effect.gen(function* () {
        const transport = yield* webTransport({
          bridges: [NavigationBridge] as const,
          layers: [layer] as const,
        })
        // Tag matches but lacks the required `path` — passes envelope, fails specific decode.
        dispatchPostMessage(JSON.stringify({ _tag: 'HostRequestedWebNavigation' }))
        yield* transport.flushed
      })
    )
    await promise
    LoggingLayerTest.expectWarningContaining(logSink, 'failed to decode message')
  })

  test('warns on malformed JSON', async () => {
    const layer = NavigationBridge.Web.ReceiverLayer({
      HostBackRequested: () => Effect.void,
      HostRequestedWebNavigation: () => Effect.void,
    })
    const { promise, logSink } = LoggingLayerTest.runScoped(
      Effect.gen(function* () {
        const transport = yield* webTransport({
          bridges: [NavigationBridge] as const,
          layers: [layer] as const,
        })
        dispatchPostMessage('not-json')
        yield* transport.flushed
      })
    )
    await promise
    LoggingLayerTest.expectWarningContaining(logSink, 'failed to decode message')
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
    const { promise } = LoggingLayerTest.runScoped(
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
      })
    )
    await promise
  })

  test('warns and drops when ReactNativeWebView is absent (standalone web)', async () => {
    delete (window as WindowWithBridge).ReactNativeWebView
    const layer = NavigationBridge.Web.ReceiverLayer({
      HostBackRequested: () => Effect.void,
      HostRequestedWebNavigation: () => Effect.void,
    })
    const { promise, logSink } = LoggingLayerTest.runScoped(
      Effect.gen(function* () {
        const transport = yield* webTransport({
          bridges: [NavigationBridge] as const,
          layers: [layer] as const,
        })
        yield* transport.sendMessage({ _tag: 'RouteChanged', pathname: '/x', canGoBack: false })
      })
    )
    await promise
    LoggingLayerTest.expectWarningContaining(logSink, 'no ReactNativeWebView in window')
  })
})

describe('BridgeTransport (Web) — __INITIAL_MESSAGES__ replay', () => {
  beforeEach(() => {
    delete (window as WindowWithBridge).__INITIAL_MESSAGES__
  })

  test('replays initial messages and deletes the global', async () => {
    const seenPaths: string[] = []
    const path = '/gatekeeper/oauth-consent/abc'
    ;(window as WindowWithBridge).__INITIAL_MESSAGES__ = [
      Schema.encodeSync(NavigationBridge.MessageSchemas.HostRequestedWebNavigation)({
        _tag: 'HostRequestedWebNavigation',
        path,
      }),
    ]

    const layer = NavigationBridge.Web.ReceiverLayer({
      HostBackRequested: () => Effect.void,
      HostRequestedWebNavigation: ({ path: p }) =>
        Effect.sync(() => {
          seenPaths.push(p)
        }),
    })
    const { promise } = LoggingLayerTest.runScoped(
      Effect.gen(function* () {
        const transport = yield* webTransport({
          bridges: [NavigationBridge] as const,
          layers: [layer] as const,
        })
        yield* transport.flushed
        expect(seenPaths).toEqual([path])
        expect((window as WindowWithBridge).__INITIAL_MESSAGES__).toBeUndefined()
      })
    )
    await promise
  })
})

describe('BridgeTransport (Web) — multi-bridge composition', () => {
  beforeEach(() => {
    delete (window as WindowWithBridge).__INITIAL_MESSAGES__
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
      hostOptionsShape: Schema.Struct({}),
      webOptionsShape: Schema.Struct({}),
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
    const { promise } = LoggingLayerTest.runScoped(
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
      })
    )
    await promise
  })

  test('throws when two bridges declare overlapping inbound tags', async () => {
    const ConflictingBackRequested = Schema.parseJson(Schema.TaggedStruct('HostBackRequested', {}))
    const Conflicting = Bridge.make({
      name: 'Conflicting',
      hostToWeb: [['HostBackRequested', ConflictingBackRequested]] as const,
      webToHost: [] as const,
      hostOptionsShape: Schema.Struct({}),
      webOptionsShape: Schema.Struct({}),
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
      /duplicate inbound tag "HostBackRequested"/
    )
  })
})

describe('BridgeTransport (Web) — type assertions (compile-only)', () => {
  test('compile-time: sendMessage rejects a tag not owned by any wired bridge', async () => {
    const layer = NavigationBridge.Web.ReceiverLayer({
      HostBackRequested: () => Effect.void,
      HostRequestedWebNavigation: () => Effect.void,
    })
    const { promise } = LoggingLayerTest.runScoped(
      Effect.gen(function* () {
        const transport = yield* webTransport({
          bridges: [NavigationBridge] as const,
          layers: [layer] as const,
        })
        // @ts-expect-error — `Bogus` is not in NavigationBridge.Web outbound.
        yield* transport.sendMessage({ _tag: 'Bogus' })
      })
    )
    await promise
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
    const { promise } = LoggingLayerTest.runScoped(
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
      })
    )
    await promise
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
    const { promise } = LoggingLayerTest.runScoped(
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
      })
    )
    await promise
  })

  test('a handler defect is logged but does not kill the dispatch fiber', async () => {
    let secondCalls = 0
    const layer = NavigationBridge.Web.ReceiverLayer({
      HostBackRequested: () => Effect.die('intentional defect'),
      HostRequestedWebNavigation: () => Effect.sync(() => (secondCalls += 1)),
    })
    const { promise, logSink } = LoggingLayerTest.runScoped(
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
      })
    )
    await promise
    LoggingLayerTest.expectWarningContaining(logSink, 'handler defect')
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
    // Run with a tight scope; the handler started but never finishes
    // because scope close interrupts it.
    const { promise } = LoggingLayerTest.runScoped(
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
        // Wait for the slow handler to start before letting the scope close.
        yield* Effect.sleep(10)
        return transport
      })
    )
    await promise
    expect(started).toBe(true)
    expect(finished).toBe(false)
  })
})

// Property: `decodeAndDispatch` produces some `DispatchError` outcome
// for any input — never a thrown defect. The transport's `flushed`
// resolves cleanly regardless of the inputs queued.
test('property: receive path survives arbitrary string inputs', async () => {
  const Buzz = Schema.parseJson(Schema.TaggedStruct('Buzz', {}))
  const SmallBridge = Bridge.make({
    name: 'Small',
    hostToWeb: [['Buzz', Buzz]] as const,
    webToHost: [] as const,
    hostOptionsShape: Schema.Struct({}),
    webOptionsShape: Schema.Struct({}),
  })
  const layer = SmallBridge.Web.ReceiverLayer({ Buzz: () => Effect.void })

  // A mix of well-formed envelopes, malformed JSON, well-formed
  // envelopes with bad payloads, and unknown tags.
  const wellFormed = fc.constant(JSON.stringify({ _tag: 'Buzz' }))
  const badPayload = fc.constant(JSON.stringify({ _tag: 'Buzz', extra: { unexpected: true } }))
  const unknownTag = fc.string({ minLength: 1, maxLength: 6 }).map((t) => JSON.stringify({ _tag: t }))
  const malformedJson = fc.string()
  const inputArb = fc.oneof(wellFormed, badPayload, unknownTag, malformedJson)

  await fc.assert(
    fc.asyncProperty(fc.array(inputArb, { maxLength: 30 }), async (inputs) => {
      const { promise } = LoggingLayerTest.runScoped(
        Effect.gen(function* () {
          const transport = yield* webTransport({
            bridges: [SmallBridge] as const,
            layers: [layer] as const,
          })
          for (const raw of inputs) dispatchPostMessage(raw)
          yield* transport.flushed
        })
      )
      await promise
    }),
    { numRuns: 25 }
  )
})

// Property: send → posts round-trip identity for arbitrary message
// sequences. (Retained from the prior test surface for coverage of
// the send-side encoding pipeline.)
test('property: sendMessage routes to the correct bridge for arbitrary message sequences', async () => {
  const Alpha = Schema.parseJson(Schema.TaggedStruct('Alpha', { x: Schema.Number }))
  const Beta = Schema.parseJson(Schema.TaggedStruct('Beta', { y: Schema.String }))
  const BridgeA = Bridge.make({
    name: 'A',
    hostToWeb: [] as const,
    webToHost: [['Alpha', Alpha]] as const,
    hostOptionsShape: Schema.Struct({}),
    webOptionsShape: Schema.Struct({}),
  })
  const BridgeB = Bridge.make({
    name: 'B',
    hostToWeb: [] as const,
    webToHost: [['Beta', Beta]] as const,
    hostOptionsShape: Schema.Struct({}),
    webOptionsShape: Schema.Struct({}),
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
      const { promise } = LoggingLayerTest.runScoped(
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
        })
      )
      await promise
      delete (window as WindowWithBridge).ReactNativeWebView
    })
  )
})
