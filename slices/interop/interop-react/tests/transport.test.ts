import { Effect, Schema } from 'effect'
import * as fc from 'fast-check'
import {
  defineBridge,
  NativeBackRequested,
  NativeRequestedWebNavigation,
  NavigationBridge,
} from 'interop-core'
import {
  type CapturedLog,
  expectWarningContaining,
  runScopedWithLogger,
} from 'interop-core/testing'
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test'
import { makeWebTransport } from '../src/transport.ts'

type WindowWithBridge = Window & {
  __INITIAL_MESSAGES__?: ReadonlyArray<string>
  ReactNativeWebView?: { postMessage(data: string): void }
}

const dispatchPostMessage = (raw: string, origin: string = window.location.origin): void => {
  const event = new MessageEvent('message', { data: raw, origin, source: window })
  window.dispatchEvent(event)
}

describe('makeWebTransport — live dispatch', () => {
  let logs: CapturedLog[]

  beforeEach(() => {
    logs = []
    delete (window as WindowWithBridge).__INITIAL_MESSAGES__
    delete (window as WindowWithBridge).ReactNativeWebView
  })

  test('routes a live NativeBackRequested to the NavigationBridge handler', async () => {
    let backCalls = 0
    const layer = NavigationBridge.Web.ReceiverLayer({
      NativeBackRequested: () => Effect.sync(() => (backCalls += 1)),
      NativeRequestedWebNavigation: () => Effect.void,
    })
    await runScopedWithLogger(
      Effect.gen(function* () {
        yield* makeWebTransport({
          bridges: [NavigationBridge] as const,
          layers: [layer] as const,
        })
        dispatchPostMessage(Schema.encodeSync(NativeBackRequested)({ _tag: 'NativeBackRequested' }))
        // Yield to let the dispatch fiber drain the queue.
        yield* Effect.sleep(0)
        expect(backCalls).toBe(1)
      }),
      logs
    )
  })

  test('routes NativeRequestedWebNavigation with its decoded payload', async () => {
    const seenPaths: string[] = []
    const layer = NavigationBridge.Web.ReceiverLayer({
      NativeBackRequested: () => Effect.void,
      NativeRequestedWebNavigation: ({ path }) =>
        Effect.sync(() => {
          seenPaths.push(path)
        }),
    })
    await runScopedWithLogger(
      Effect.gen(function* () {
        yield* makeWebTransport({
          bridges: [NavigationBridge] as const,
          layers: [layer] as const,
        })
        dispatchPostMessage(
          Schema.encodeSync(NativeRequestedWebNavigation)({
            _tag: 'NativeRequestedWebNavigation',
            path: '/gatekeeper',
          })
        )
        yield* Effect.sleep(0)
        expect(seenPaths).toEqual(['/gatekeeper'])
      }),
      logs
    )
  })

  test('ignores events from a foreign origin', async () => {
    let backCalls = 0
    const layer = NavigationBridge.Web.ReceiverLayer({
      NativeBackRequested: () => Effect.sync(() => (backCalls += 1)),
      NativeRequestedWebNavigation: () => Effect.void,
    })
    await runScopedWithLogger(
      Effect.gen(function* () {
        yield* makeWebTransport({
          bridges: [NavigationBridge] as const,
          layers: [layer] as const,
        })
        dispatchPostMessage(
          Schema.encodeSync(NativeBackRequested)({ _tag: 'NativeBackRequested' }),
          'https://attacker.example'
        )
        yield* Effect.sleep(0)
        expect(backCalls).toBe(0)
      }),
      logs
    )
  })

  test('warns on unknown live tags without throwing', async () => {
    const layer = NavigationBridge.Web.ReceiverLayer({
      NativeBackRequested: () => Effect.void,
      NativeRequestedWebNavigation: () => Effect.void,
    })
    await runScopedWithLogger(
      Effect.gen(function* () {
        yield* makeWebTransport({
          bridges: [NavigationBridge] as const,
          layers: [layer] as const,
        })
        dispatchPostMessage(JSON.stringify({ _tag: 'NotARealTag' }))
        yield* Effect.sleep(0)
        expectWarningContaining(logs, 'unknown live message tag: "NotARealTag"')
      }),
      logs
    )
  })

  test('warns when a known tag fails to decode', async () => {
    const layer = NavigationBridge.Web.ReceiverLayer({
      NativeBackRequested: () => Effect.void,
      NativeRequestedWebNavigation: () => Effect.void,
    })
    await runScopedWithLogger(
      Effect.gen(function* () {
        yield* makeWebTransport({
          bridges: [NavigationBridge] as const,
          layers: [layer] as const,
        })
        // Tag matches but lacks the required `path` — passes envelope, fails specific decode.
        dispatchPostMessage(JSON.stringify({ _tag: 'NativeRequestedWebNavigation' }))
        yield* Effect.sleep(0)
        expectWarningContaining(logs, 'failed to decode message')
      }),
      logs
    )
  })

  test('warns on malformed JSON', async () => {
    const layer = NavigationBridge.Web.ReceiverLayer({
      NativeBackRequested: () => Effect.void,
      NativeRequestedWebNavigation: () => Effect.void,
    })
    await runScopedWithLogger(
      Effect.gen(function* () {
        yield* makeWebTransport({
          bridges: [NavigationBridge] as const,
          layers: [layer] as const,
        })
        dispatchPostMessage('not-json')
        yield* Effect.sleep(0)
        expectWarningContaining(logs, 'failed to decode message')
      }),
      logs
    )
  })
})

describe('makeWebTransport — sendMessage', () => {
  let logs: CapturedLog[]
  let posts: string[]

  beforeEach(() => {
    logs = []
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
      NativeBackRequested: () => Effect.void,
      NativeRequestedWebNavigation: () => Effect.void,
    })
    await runScopedWithLogger(
      Effect.gen(function* () {
        const transport = yield* makeWebTransport({
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
      }),
      logs
    )
  })

  test('warns and drops when ReactNativeWebView is absent (standalone web)', async () => {
    delete (window as WindowWithBridge).ReactNativeWebView

    const layer = NavigationBridge.Web.ReceiverLayer({
      NativeBackRequested: () => Effect.void,
      NativeRequestedWebNavigation: () => Effect.void,
    })
    await runScopedWithLogger(
      Effect.gen(function* () {
        const transport = yield* makeWebTransport({
          bridges: [NavigationBridge] as const,
          layers: [layer] as const,
        })
        yield* transport.sendMessage({ _tag: 'RouteChanged', pathname: '/x', canGoBack: false })
        expectWarningContaining(logs, 'no ReactNativeWebView in window')
      }),
      logs
    )
  })
})

describe('makeWebTransport — __INITIAL_MESSAGES__ replay', () => {
  let logs: CapturedLog[]

  beforeEach(() => {
    logs = []
    delete (window as WindowWithBridge).__INITIAL_MESSAGES__
  })

  test('replays initial messages synchronously and deletes the global', async () => {
    const seenPaths: string[] = []
    const path = '/gatekeeper/oauth-consent/abc'
    ;(window as WindowWithBridge).__INITIAL_MESSAGES__ = [
      Schema.encodeSync(NativeRequestedWebNavigation)({
        _tag: 'NativeRequestedWebNavigation',
        path,
      }),
    ]

    const layer = NavigationBridge.Web.ReceiverLayer({
      NativeBackRequested: () => Effect.void,
      NativeRequestedWebNavigation: ({ path: p }) =>
        Effect.sync(() => {
          seenPaths.push(p)
        }),
    })
    await runScopedWithLogger(
      Effect.gen(function* () {
        yield* makeWebTransport({
          bridges: [NavigationBridge] as const,
          layers: [layer] as const,
        })
        // Replay happens during construction; the dispatch fiber drains
        // asynchronously, so yield once for the queue to flush.
        yield* Effect.sleep(0)
        expect(seenPaths).toEqual([path])
        expect((window as WindowWithBridge).__INITIAL_MESSAGES__).toBeUndefined()
      }),
      logs
    )
  })
})

describe('makeWebTransport — multi-bridge composition', () => {
  let logs: CapturedLog[]

  beforeEach(() => {
    logs = []
    delete (window as WindowWithBridge).__INITIAL_MESSAGES__
  })

  test('routes inbound messages to the correct bridge by tag', async () => {
    const Pong = Schema.parseJson(Schema.TaggedStruct('Pong', { reply: Schema.String }))
    const Buzz = Schema.parseJson(Schema.TaggedStruct('Buzz', {}))
    const TestBridge = defineBridge({
      name: 'Test',
      nativeToWeb: [
        ['Pong', Pong],
        ['Buzz', Buzz],
      ] as const,
      webToNative: [] as const,
      nativeOptionsShape: Schema.Struct({}),
      webOptionsShape: Schema.Struct({}),
    })

    let backCalls = 0
    let buzzCalls = 0
    const navLayer = NavigationBridge.Web.ReceiverLayer({
      NativeBackRequested: () => Effect.sync(() => (backCalls += 1)),
      NativeRequestedWebNavigation: () => Effect.void,
    })
    const testLayer = TestBridge.Web.ReceiverLayer({
      Pong: () => Effect.void,
      Buzz: () => Effect.sync(() => (buzzCalls += 1)),
    })
    await runScopedWithLogger(
      Effect.gen(function* () {
        yield* makeWebTransport({
          bridges: [NavigationBridge, TestBridge] as const,
          layers: [navLayer, testLayer] as const,
        })
        dispatchPostMessage(Schema.encodeSync(NativeBackRequested)({ _tag: 'NativeBackRequested' }))
        dispatchPostMessage(Schema.encodeSync(Buzz)({ _tag: 'Buzz' }))
        yield* Effect.sleep(0)
        expect(backCalls).toBe(1)
        expect(buzzCalls).toBe(1)
      }),
      logs
    )
  })

  test('throws when two bridges declare overlapping inbound tags', async () => {
    const ConflictingBackRequested = Schema.parseJson(
      Schema.TaggedStruct('NativeBackRequested', {})
    )
    const Conflicting = defineBridge({
      name: 'Conflicting',
      nativeToWeb: [['NativeBackRequested', ConflictingBackRequested]] as const,
      webToNative: [] as const,
      nativeOptionsShape: Schema.Struct({}),
      webOptionsShape: Schema.Struct({}),
    })

    const navLayer = NavigationBridge.Web.ReceiverLayer({
      NativeBackRequested: () => Effect.void,
      NativeRequestedWebNavigation: () => Effect.void,
    })
    const conflictingLayer = Conflicting.Web.ReceiverLayer({
      NativeBackRequested: () => Effect.void,
    })

    const program = Effect.scoped(
      makeWebTransport({
        bridges: [NavigationBridge, Conflicting] as const,
        layers: [navLayer, conflictingLayer] as const,
      })
    )
    await expect(Effect.runPromise(program)).rejects.toThrow(
      /duplicate inbound tag "NativeBackRequested"/
    )
  })
})

describe('makeWebTransport — type assertions (compile-only)', () => {
  test('compile-time: sendMessage rejects a tag not owned by any wired bridge', async () => {
    const layer = NavigationBridge.Web.ReceiverLayer({
      NativeBackRequested: () => Effect.void,
      NativeRequestedWebNavigation: () => Effect.void,
    })
    const logs: CapturedLog[] = []
    await runScopedWithLogger(
      Effect.gen(function* () {
        const transport = yield* makeWebTransport({
          bridges: [NavigationBridge] as const,
          layers: [layer] as const,
        })
        // @ts-expect-error — `Bogus` is not in NavigationBridge.Web outbound.
        yield* transport.sendMessage({ _tag: 'Bogus' })
      }),
      logs
    )
  })
})

test('property: sendMessage routes to the correct bridge for arbitrary message sequences', async () => {
  const Alpha = Schema.parseJson(Schema.TaggedStruct('Alpha', { x: Schema.Number }))
  const Beta = Schema.parseJson(Schema.TaggedStruct('Beta', { y: Schema.String }))
  const BridgeA = defineBridge({
    name: 'A',
    nativeToWeb: [] as const,
    webToNative: [['Alpha', Alpha]] as const,
    nativeOptionsShape: Schema.Struct({}),
    webOptionsShape: Schema.Struct({}),
  })
  const BridgeB = defineBridge({
    name: 'B',
    nativeToWeb: [] as const,
    webToNative: [['Beta', Beta]] as const,
    nativeOptionsShape: Schema.Struct({}),
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
      const logs: CapturedLog[] = []
      await runScopedWithLogger(
        Effect.gen(function* () {
          const transport = yield* makeWebTransport({
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
        }),
        logs
      )
      delete (window as WindowWithBridge).ReactNativeWebView
    })
  )
})
