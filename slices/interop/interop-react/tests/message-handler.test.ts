import { Schema } from 'effect'
import {
  AppNavigationRequested,
  InteropNativeToWeb,
  InteropWebToNative,
  NativeBackRequested,
} from 'interop-core'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'
import { makeWebMessageHandler } from '../src/message-handler.ts'

type WindowWithBridge = Window & {
  __INITIAL_MESSAGES__?: ReadonlyArray<string>
  ReactNativeWebView?: { postMessage(data: string): void }
}

const dispatchPostMessage = (raw: string, origin: string = window.location.origin): void => {
  // JSDOM's MessageEvent constructor accepts source/origin overrides.
  const event = new MessageEvent('message', { data: raw, origin, source: window })
  window.dispatchEvent(event)
}

describe('makeWebMessageHandler', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    delete (window as WindowWithBridge).__INITIAL_MESSAGES__
    delete (window as WindowWithBridge).ReactNativeWebView
  })
  afterEach(() => {
    warnSpy.mockRestore()
  })

  test('decodes live postMessage events into the receive dispatcher', () => {
    const handler = makeWebMessageHandler({
      receive: InteropNativeToWeb,
      send: InteropWebToNative,
    })
    const seen: ReadonlyArray<{ readonly _tag: 'NativeBackRequested' }> = []
    const captured: Array<{ readonly _tag: 'NativeBackRequested' }> = [...seen]
    handler.setMessageListener('NativeBackRequested', (m) => {
      captured.push(m)
    })

    const encoded = Schema.encodeSync(NativeBackRequested)({ _tag: 'NativeBackRequested' })
    dispatchPostMessage(encoded)

    expect(captured).toHaveLength(1)
    expect(captured[0]?._tag).toBe('NativeBackRequested')
    handler.dispose()
  })

  test('ignores events from a foreign origin', () => {
    const handler = makeWebMessageHandler({
      receive: InteropNativeToWeb,
      send: InteropWebToNative,
    })
    const captured: Array<{ readonly _tag: 'NativeBackRequested' }> = []
    handler.setMessageListener('NativeBackRequested', (m) => {
      captured.push(m)
    })

    const encoded = Schema.encodeSync(NativeBackRequested)({ _tag: 'NativeBackRequested' })
    dispatchPostMessage(encoded, 'https://attacker.example')

    expect(captured).toHaveLength(0)
    handler.dispose()
  })

  test('ignores non-string event data', () => {
    const handler = makeWebMessageHandler({
      receive: InteropNativeToWeb,
      send: InteropWebToNative,
    })
    const captured: Array<{ readonly _tag: 'NativeBackRequested' }> = []
    handler.setMessageListener('NativeBackRequested', (m) => {
      captured.push(m)
    })

    const event = new MessageEvent('message', {
      data: { _tag: 'NativeBackRequested' },
      origin: window.location.origin,
      source: window,
    })
    window.dispatchEvent(event)

    expect(captured).toHaveLength(0)
    handler.dispose()
  })

  test('warns on unknown live tags without throwing', () => {
    const handler = makeWebMessageHandler({
      receive: InteropNativeToWeb,
      send: InteropWebToNative,
    })
    dispatchPostMessage(JSON.stringify({ _tag: 'NotARealTag' }))
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('unknown live message tag: "NotARealTag"')
    )
    handler.dispose()
  })

  test('replays window.__INITIAL_MESSAGES__ synchronously and deletes the global', () => {
    const initialPath = '/gatekeeper/oauth-consent/abc'
    ;(window as WindowWithBridge).__INITIAL_MESSAGES__ = [
      Schema.encodeSync(AppNavigationRequested)({
        _tag: 'AppNavigationRequested',
        path: initialPath,
      }),
    ]

    // AppNavigationRequested is Native→Web in the corrected direction
    // model, so the web handler receives it.
    const handler = makeWebMessageHandler({
      receive: InteropNativeToWeb,
      send: InteropWebToNative,
    })

    // The buffered message is available *immediately* after construction —
    // before any React render. This is the no-flicker contract.
    const drained = handler.consumeBuffered('AppNavigationRequested')
    expect(drained.map((m) => m.path)).toEqual([initialPath])
    expect((window as WindowWithBridge).__INITIAL_MESSAGES__).toBeUndefined()

    handler.dispose()
  })

  test('a listener registered after consumeBuffered only sees future messages', () => {
    ;(window as WindowWithBridge).__INITIAL_MESSAGES__ = [
      Schema.encodeSync(AppNavigationRequested)({
        _tag: 'AppNavigationRequested',
        path: '/initial',
      }),
    ]
    // AppNavigationRequested is Native→Web in the corrected direction
    // model, so the web handler receives it.
    const handler = makeWebMessageHandler({
      receive: InteropNativeToWeb,
      send: InteropWebToNative,
    })
    const drained = handler.consumeBuffered('AppNavigationRequested')
    expect(drained).toHaveLength(1)

    const seen: Array<{ readonly path: string }> = []
    handler.setMessageListener('AppNavigationRequested', (m) => {
      seen.push(m)
    })
    expect(seen).toHaveLength(0)

    dispatchPostMessage(
      Schema.encodeSync(AppNavigationRequested)({
        _tag: 'AppNavigationRequested',
        path: '/later',
      })
    )
    expect(seen.map((m) => m.path)).toEqual(['/later'])
    handler.dispose()
  })

  test('sendMessage encodes and posts to ReactNativeWebView when present', () => {
    const posts: string[] = []
    ;(window as WindowWithBridge).ReactNativeWebView = {
      postMessage: (data) => {
        posts.push(data)
      },
    }
    const handler = makeWebMessageHandler({
      receive: InteropNativeToWeb,
      send: InteropWebToNative,
    })
    handler.sendMessage({ _tag: 'RouteChanged', pathname: '/x', canGoBack: true })
    expect(posts).toHaveLength(1)
    expect(JSON.parse(posts[0] ?? '')).toEqual({
      _tag: 'RouteChanged',
      pathname: '/x',
      canGoBack: true,
    })
    handler.dispose()
  })

  test('sendMessage warns and drops when ReactNativeWebView is absent (standalone web)', () => {
    const handler = makeWebMessageHandler({
      receive: InteropNativeToWeb,
      send: InteropWebToNative,
    })
    handler.sendMessage({ _tag: 'RouteChanged', pathname: '/x', canGoBack: false })
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('no ReactNativeWebView in window'))
    handler.dispose()
  })

  test('dispose() detaches the message listener (subsequent posts are ignored)', () => {
    const handler = makeWebMessageHandler({
      receive: InteropNativeToWeb,
      send: InteropWebToNative,
    })
    const captured: Array<{ readonly _tag: 'NativeBackRequested' }> = []
    handler.setMessageListener('NativeBackRequested', (m) => {
      captured.push(m)
    })
    handler.dispose()
    dispatchPostMessage(Schema.encodeSync(NativeBackRequested)({ _tag: 'NativeBackRequested' }))
    expect(captured).toHaveLength(0)
  })
})
