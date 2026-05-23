import { Effect, Exit, Schema, Scope } from 'effect'
import { Bridge, UrlParamMessage } from 'effect-messaging-core'
import { LoggingLayerTest } from 'kitchen-sink/test'
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test'
import * as WebPlatformAdapter from '../src/web-platform-adapter.ts'

type WindowWithBridge = Window & {
  ReactNativeWebView?: { postMessage(data: string): void }
}

// Test fixture bridge — a single host→web message with one string field.
const Hello = Schema.parseJson(Schema.TaggedStruct('Hello', { msg: Schema.String }))
const TestBridge = Bridge.make({
  name: 'Test',
  hostToWeb: [['Hello', Hello]] as const,
  webToHost: [] as const,
  urlParams: {
    Hello: UrlParamMessage.singleStringMessageSchema('Hello', 'msg'),
  },
})
const testBridges = [TestBridge] as const

const requireAttachLive = (
  adapter: ReturnType<typeof WebPlatformAdapter.make>
): NonNullable<typeof adapter.attachLive> => {
  if (adapter.attachLive === undefined) throw new Error('attachLive missing')
  return adapter.attachLive
}

const setHelloUrlParam = (msg: string): void => {
  const url = new URL(window.location.href)
  const next = UrlParamMessage.appendMessagesToUrl(url, testBridges, [{ _tag: 'Hello', msg }])
  window.history.replaceState({}, '', next.toString())
}

const clearUrlSearch = (): void => {
  const url = new URL(window.location.href)
  url.search = ''
  window.history.replaceState({}, '', url.toString())
}

beforeEach(() => {
  clearUrlSearch()
  delete (window as WindowWithBridge).ReactNativeWebView
})

afterEach(() => {
  clearUrlSearch()
  delete (window as WindowWithBridge).ReactNativeWebView
})

describe('WebPlatformAdapter.make — drainInitial', () => {
  test('decodes URL params via the supplied bridges and strips them', () => {
    setHelloUrlParam('hi there')
    expect(window.location.search).toContain('Hello')

    const adapter = WebPlatformAdapter.make(testBridges)
    const drained = Effect.runSync(adapter.drainInitial)
    expect(drained).toHaveLength(1)
    expect(JSON.parse(drained[0] ?? '')).toEqual({ _tag: 'Hello', msg: 'hi there' })
    expect(window.location.search).not.toContain('Hello')
  })

  test('returns [] and leaves the URL untouched when no bridge params are present', () => {
    const url = new URL(window.location.href)
    url.search = '?keep=me'
    window.history.replaceState({}, '', url.toString())

    const adapter = WebPlatformAdapter.make(testBridges)
    expect(Effect.runSync(adapter.drainInitial)).toEqual([])
    expect(window.location.search).toBe('?keep=me')
  })

  test('preserves non-bridge params when stripping', () => {
    const url = new URL(window.location.href)
    url.search = ''
    url.searchParams.append('keep', 'me')
    window.history.replaceState({}, '', url.toString())
    setHelloUrlParam('payload')
    const adapter = WebPlatformAdapter.make(testBridges)
    Effect.runSync(adapter.drainInitial)
    expect(new URL(window.location.href).searchParams.get('keep')).toBe('me')
    expect(window.location.search).not.toContain('Hello')
  })
})

describe('WebPlatformAdapter.make — bareSender', () => {
  test('warns and drops when ReactNativeWebView is absent', async () => {
    const adapter = WebPlatformAdapter.make([])
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* adapter.bareSender('payload')
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

  test('forwards to ReactNativeWebView.postMessage when present', () => {
    const sent: string[] = []
    ;(window as WindowWithBridge).ReactNativeWebView = {
      postMessage: (data) => sent.push(data),
    }
    const adapter = WebPlatformAdapter.make([])
    Effect.runSync(adapter.bareSender('payload-1'))
    Effect.runSync(adapter.bareSender('payload-2'))
    expect(sent).toEqual(['payload-1', 'payload-2'])
  })
})

describe('WebPlatformAdapter.make — attachLive', () => {
  test('detaches the window listener on scope close', async () => {
    const adapter = WebPlatformAdapter.make([])
    const attachLive = requireAttachLive(adapter)
    const seen: string[] = []
    const scope = Effect.runSync(Scope.make())
    await Effect.runPromise(
      Scope.extend(
        attachLive((raw) =>
          Effect.sync(() => {
            seen.push(raw)
          })
        ),
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
    const adapter = WebPlatformAdapter.make([])
    const attachLive = requireAttachLive(adapter)
    const seen: string[] = []
    const scope = Effect.runSync(Scope.make())
    await Effect.runPromise(
      Scope.extend(
        attachLive((raw) =>
          Effect.sync(() => {
            seen.push(raw)
          })
        ),
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

  test('admits source-less native dispatches (RN-WebView iOS injection sets neither source nor origin)', async () => {
    // iOS RN-WebView's `RNCWebViewImpl.m` postMessage path injects
    // `window.dispatchEvent(new MessageEvent('message', {data: '<msg>'}))`
    // into the page. The init dict carries only `data`; `event.source`
    // defaults to `null` and `event.origin` to `''`. A strict
    // `event.source !== window` check would silently drop every host→web
    // message on iOS.
    const adapter = WebPlatformAdapter.make([])
    const attachLive = requireAttachLive(adapter)
    const seen: string[] = []
    const scope = Effect.runSync(Scope.make())
    await Effect.runPromise(
      Scope.extend(
        attachLive((raw) =>
          Effect.sync(() => {
            seen.push(raw)
          })
        ),
        scope
      )
    )
    window.dispatchEvent(new MessageEvent('message', { data: 'native-injected' }))
    expect(seen).toEqual(['native-injected'])
    await Effect.runPromise(Scope.close(scope, Exit.void))
  })

  test('ignores foreign-origin events', async () => {
    const adapter = WebPlatformAdapter.make([])
    const attachLive = requireAttachLive(adapter)
    const seen: string[] = []
    const scope = Effect.runSync(Scope.make())
    await Effect.runPromise(
      Scope.extend(
        attachLive((raw) =>
          Effect.sync(() => {
            seen.push(raw)
          })
        ),
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
