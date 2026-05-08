import { NavigationBridge } from 'contracts-core'
import { Effect, Schema } from 'effect'
import { Bridge } from 'effect-messaging-core'
import * as fc from 'fast-check'
import { LoggingLayerTest } from 'kitchen-sink/test'
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test'
import * as WebTransport from '../src/web-transport.ts'

type WindowWithBridge = Window & {
  __INITIAL_MESSAGES__?: ReadonlyArray<string>
  ReactNativeWebView?: { postMessage(data: string): void }
}

const dispatchPostMessage = (raw: string, origin: string = window.location.origin): void => {
  const event = new MessageEvent('message', { data: raw, origin, source: window })
  window.dispatchEvent(event)
}

describe('WebTransport.make — live dispatch', () => {
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
        yield* WebTransport.make({
          bridges: [NavigationBridge] as const,
          layers: [layer] as const,
        })
        dispatchPostMessage(
          Schema.encodeSync(NavigationBridge.MessageSchemas.HostBackRequested)({
            _tag: 'HostBackRequested',
          })
        )
        // Yield to let the dispatch fiber drain the queue.
        yield* Effect.sleep(0)
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
        yield* WebTransport.make({
          bridges: [NavigationBridge] as const,
          layers: [layer] as const,
        })
        dispatchPostMessage(
          Schema.encodeSync(NavigationBridge.MessageSchemas.HostRequestedWebNavigation)({
            _tag: 'HostRequestedWebNavigation',
            path: '/gatekeeper',
          })
        )
        yield* Effect.sleep(0)
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
        yield* WebTransport.make({
          bridges: [NavigationBridge] as const,
          layers: [layer] as const,
        })
        dispatchPostMessage(
          Schema.encodeSync(NavigationBridge.MessageSchemas.HostBackRequested)({
            _tag: 'HostBackRequested',
          }),
          'https://attacker.example'
        )
        yield* Effect.sleep(0)
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
        yield* WebTransport.make({
          bridges: [NavigationBridge] as const,
          layers: [layer] as const,
        })
        dispatchPostMessage(JSON.stringify({ _tag: 'NotARealTag' }))
        yield* Effect.sleep(0)
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
        yield* WebTransport.make({
          bridges: [NavigationBridge] as const,
          layers: [layer] as const,
        })
        // Tag matches but lacks the required `path` — passes envelope, fails specific decode.
        dispatchPostMessage(JSON.stringify({ _tag: 'HostRequestedWebNavigation' }))
        yield* Effect.sleep(0)
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
        yield* WebTransport.make({
          bridges: [NavigationBridge] as const,
          layers: [layer] as const,
        })
        dispatchPostMessage('not-json')
        yield* Effect.sleep(0)
      })
    )
    await promise
    LoggingLayerTest.expectWarningContaining(logSink, 'failed to decode message')
  })
})

describe('WebTransport.make — sendMessage', () => {
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
        const transport = yield* WebTransport.make({
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
        const transport = yield* WebTransport.make({
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

describe('WebTransport.make — __INITIAL_MESSAGES__ replay', () => {
  beforeEach(() => {
    delete (window as WindowWithBridge).__INITIAL_MESSAGES__
  })

  test('replays initial messages synchronously and deletes the global', async () => {
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
        yield* WebTransport.make({
          bridges: [NavigationBridge] as const,
          layers: [layer] as const,
        })
        // Replay happens during construction; the dispatch fiber drains
        // asynchronously, so yield once for the queue to flush.
        yield* Effect.sleep(0)
        expect(seenPaths).toEqual([path])
        expect((window as WindowWithBridge).__INITIAL_MESSAGES__).toBeUndefined()
      })
    )
    await promise
  })
})

describe('WebTransport.make — multi-bridge composition', () => {
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
        yield* WebTransport.make({
          bridges: [NavigationBridge, TestBridge] as const,
          layers: [navLayer, testLayer] as const,
        })
        dispatchPostMessage(
          Schema.encodeSync(NavigationBridge.MessageSchemas.HostBackRequested)({
            _tag: 'HostBackRequested',
          })
        )
        dispatchPostMessage(Schema.encodeSync(Buzz)({ _tag: 'Buzz' }))
        yield* Effect.sleep(0)
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
      WebTransport.make({
        bridges: [NavigationBridge, Conflicting] as const,
        layers: [navLayer, conflictingLayer] as const,
      })
    )
    await expect(Effect.runPromise(program)).rejects.toThrow(
      /duplicate inbound tag "HostBackRequested"/
    )
  })
})

describe('WebTransport.make — type assertions (compile-only)', () => {
  test('compile-time: sendMessage rejects a tag not owned by any wired bridge', async () => {
    const layer = NavigationBridge.Web.ReceiverLayer({
      HostBackRequested: () => Effect.void,
      HostRequestedWebNavigation: () => Effect.void,
    })
    const { promise } = LoggingLayerTest.runScoped(
      Effect.gen(function* () {
        const transport = yield* WebTransport.make({
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
          const transport = yield* WebTransport.make({
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
