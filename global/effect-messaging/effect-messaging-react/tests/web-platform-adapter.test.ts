import { Effect, Exit, Scope } from 'effect'
import { LoggingLayerTest } from 'kitchen-sink/test'
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test'
import * as WebPlatformAdapter from '../src/web-platform-adapter.ts'

type WindowWithBridge = Window & {
  __INITIAL_MESSAGES__?: ReadonlyArray<unknown>
  ReactNativeWebView?: { postMessage(data: string): void }
}

const requireAttachLive = (
  adapter: ReturnType<typeof WebPlatformAdapter.make>
): NonNullable<typeof adapter.attachLive> => {
  if (adapter.attachLive === undefined) throw new Error('attachLive missing')
  return adapter.attachLive
}

beforeEach(() => {
  delete (window as WindowWithBridge).__INITIAL_MESSAGES__
  delete (window as WindowWithBridge).ReactNativeWebView
})

afterEach(() => {
  delete (window as WindowWithBridge).__INITIAL_MESSAGES__
  delete (window as WindowWithBridge).ReactNativeWebView
})

describe('WebPlatformAdapter.make — drainInitial', () => {
  test('returns the array verbatim and deletes the global', () => {
    ;(window as WindowWithBridge).__INITIAL_MESSAGES__ = ['a', 'b', 'c']
    const adapter = WebPlatformAdapter.make()
    const drained = Effect.runSync(adapter.drainInitial)
    expect(drained).toEqual(['a', 'b', 'c'])
    expect((window as WindowWithBridge).__INITIAL_MESSAGES__).toBeUndefined()
  })

  test('drops non-string entries silently', () => {
    ;(window as WindowWithBridge).__INITIAL_MESSAGES__ = ['a', 1, null, { _tag: 'X' }, 'b']
    const adapter = WebPlatformAdapter.make()
    const drained = Effect.runSync(adapter.drainInitial)
    expect(drained).toEqual(['a', 'b'])
  })

  test('returns [] when the global is missing or not an array', () => {
    const adapter = WebPlatformAdapter.make()
    expect(Effect.runSync(adapter.drainInitial)).toEqual([])
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    ;(window as WindowWithBridge).__INITIAL_MESSAGES__ = 'not-an-array' as never
    expect(Effect.runSync(adapter.drainInitial)).toEqual([])
  })
})

describe('WebPlatformAdapter.make — bareSender', () => {
  test('warns and drops when ReactNativeWebView is absent', async () => {
    const adapter = WebPlatformAdapter.make()
    const { promise, logSink } = LoggingLayerTest.runScoped(
      Effect.gen(function* () {
        yield* adapter.bareSender('payload')
      })
    )
    await promise
    LoggingLayerTest.expectWarningContaining(logSink, 'no ReactNativeWebView in window')
  })

  test('forwards to ReactNativeWebView.postMessage when present', () => {
    const sent: string[] = []
    ;(window as WindowWithBridge).ReactNativeWebView = {
      postMessage: (data) => sent.push(data),
    }
    const adapter = WebPlatformAdapter.make()
    Effect.runSync(adapter.bareSender('payload-1'))
    Effect.runSync(adapter.bareSender('payload-2'))
    expect(sent).toEqual(['payload-1', 'payload-2'])
  })
})

describe('WebPlatformAdapter.make — attachLive', () => {
  test('detaches the window listener on scope close', async () => {
    const adapter = WebPlatformAdapter.make()
    const attachLive = requireAttachLive(adapter)
    const seen: string[] = []
    const scope = Effect.runSync(Scope.make())
    await Effect.runPromise(
      Scope.extend(
        attachLive((raw) => seen.push(raw)),
        scope
      )
    )

    window.dispatchEvent(
      new MessageEvent('message', { data: 'live', origin: window.location.origin, source: window })
    )
    expect(seen).toEqual(['live'])

    await Effect.runPromise(Scope.close(scope, Exit.void))
    window.dispatchEvent(
      new MessageEvent('message', { data: 'after', origin: window.location.origin, source: window })
    )
    expect(seen).toEqual(['live'])
  })

  test('ignores non-string event data', async () => {
    const adapter = WebPlatformAdapter.make()
    const attachLive = requireAttachLive(adapter)
    const seen: string[] = []
    const scope = Effect.runSync(Scope.make())
    await Effect.runPromise(
      Scope.extend(
        attachLive((raw) => seen.push(raw)),
        scope
      )
    )
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { not: 'a string' },
        origin: window.location.origin,
        source: window,
      })
    )
    expect(seen).toEqual([])
    await Effect.runPromise(Scope.close(scope, Exit.void))
  })

  test('ignores foreign-origin events', async () => {
    const adapter = WebPlatformAdapter.make()
    const attachLive = requireAttachLive(adapter)
    const seen: string[] = []
    const scope = Effect.runSync(Scope.make())
    await Effect.runPromise(
      Scope.extend(
        attachLive((raw) => seen.push(raw)),
        scope
      )
    )
    window.dispatchEvent(
      new MessageEvent('message', {
        data: 'foreign',
        origin: 'https://attacker.example',
        source: window,
      })
    )
    expect(seen).toEqual([])
    await Effect.runPromise(Scope.close(scope, Exit.void))
  })
})
