import { Schema } from 'effect'
import {
  AppNavigationRequested,
  InteropNativeToWeb,
  InteropWebToNative,
  NativeBackRequested,
  RouteChanged,
} from 'interop-core'
import type { RefObject } from 'react'
import type { WebViewMessageEvent } from 'react-native-webview'
import type { EmbeddedWebViewHandle } from './embedded-webview.tsx'
import { makeExpoMessageHandler } from './message-handler.ts'

const makeHandleRef = (): {
  ref: RefObject<EmbeddedWebViewHandle | null>
  posts: string[]
} => {
  const posts: string[] = []
  const ref: RefObject<EmbeddedWebViewHandle | null> = {
    current: {
      postMessage: (raw) => {
        posts.push(raw)
      },
    },
  }
  return { ref, posts }
}

const fakeOnMessage = (raw: string): WebViewMessageEvent =>
  // The onMessage handler only reads .nativeEvent.data; the rest is unused.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  ({ nativeEvent: { data: raw } }) as unknown as WebViewMessageEvent

describe('makeExpoMessageHandler', () => {
  let warnSpy: jest.SpyInstance
  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  })
  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('publishes __INITIAL_MESSAGES__ with each pre-encoded entry verbatim', () => {
    const { ref } = makeHandleRef()
    const initialMessages = [
      Schema.encodeSync(AppNavigationRequested)({
        _tag: 'AppNavigationRequested',
        path: '/x',
      }),
    ]
    const { injectedScript } = makeExpoMessageHandler(
      { receive: InteropWebToNative, send: InteropNativeToWeb },
      ref,
      initialMessages
    )

    // Evaluate the script in a sandbox-ish env: the script ends with `; true;`
    // and assigns to a window-like object.
    const sandbox: { __INITIAL_MESSAGES__?: ReadonlyArray<string> } = {}
    // Evaluating a tiny generated script in a controlled sandbox to
    // verify the script's effect on `window.__INITIAL_MESSAGES__` is the
    // best way to assert the contract; the no-implied-eval rule is
    // intentionally suppressed for this isolated test scope.
    // oxlint-disable-next-line typescript-eslint/no-implied-eval
    new Function('window', injectedScript)(sandbox)
    expect(sandbox.__INITIAL_MESSAGES__).toEqual(initialMessages)
  })

  it('escapes special characters so the injected script is JS-safe', () => {
    const { ref } = makeHandleRef()
    // A string with an embedded `</script>` and unicode line separators —
    // historically problematic for naive JSON-in-HTML embedding.
    const dodgy = '</script>  "end"'
    const { injectedScript } = makeExpoMessageHandler(
      { receive: InteropWebToNative, send: InteropNativeToWeb },
      ref,
      [dodgy]
    )
    const sandbox: { __INITIAL_MESSAGES__?: ReadonlyArray<string> } = {}
    // Evaluating a tiny generated script in a controlled sandbox to
    // verify the script's effect on `window.__INITIAL_MESSAGES__` is the
    // best way to assert the contract; the no-implied-eval rule is
    // intentionally suppressed for this isolated test scope.
    // oxlint-disable-next-line typescript-eslint/no-implied-eval
    new Function('window', injectedScript)(sandbox)
    expect(sandbox.__INITIAL_MESSAGES__).toEqual([dodgy])
  })

  it('decodes incoming WebView messages and routes them through the dispatcher', () => {
    const { ref } = makeHandleRef()
    // The Expo handler receives Web→Native — currently `RouteChanged`.
    const { handler, onMessage } = makeExpoMessageHandler(
      { receive: InteropWebToNative, send: InteropNativeToWeb },
      ref,
      []
    )
    const seen: Array<{
      readonly _tag: 'RouteChanged'
      readonly pathname: string
      readonly canGoBack: boolean
    }> = []
    handler.setMessageListener('RouteChanged', (m) => {
      seen.push(m)
    })

    const encoded = Schema.encodeSync(RouteChanged)({
      _tag: 'RouteChanged',
      pathname: '/x/y',
      canGoBack: true,
    })
    onMessage(fakeOnMessage(encoded))

    expect(seen).toEqual([{ _tag: 'RouteChanged', pathname: '/x/y', canGoBack: true }])
    handler.dispose()
  })

  it('sendMessage encodes and pushes through the imperative handle ref', () => {
    const { ref, posts } = makeHandleRef()
    const { handler } = makeExpoMessageHandler(
      { receive: InteropWebToNative, send: InteropNativeToWeb },
      ref,
      []
    )
    handler.sendMessage({ _tag: 'NativeBackRequested' })
    expect(posts).toHaveLength(1)
    expect(JSON.parse(posts[0] ?? '')).toEqual({ _tag: 'NativeBackRequested' })
    handler.dispose()
  })

  it('sendMessage warns and drops when the WebView ref is null (pre-mount)', () => {
    const ref: RefObject<EmbeddedWebViewHandle | null> = { current: null }
    const { handler } = makeExpoMessageHandler(
      { receive: InteropWebToNative, send: InteropNativeToWeb },
      ref,
      []
    )
    handler.sendMessage({ _tag: 'NativeBackRequested' })
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('no WebView handle yet'))
    handler.dispose()
  })

  it('warns on unknown tags from the page', () => {
    const { ref } = makeHandleRef()
    const { handler, onMessage } = makeExpoMessageHandler(
      { receive: InteropWebToNative, send: InteropNativeToWeb },
      ref,
      []
    )
    onMessage(fakeOnMessage(JSON.stringify({ _tag: 'NotARealTag' })))
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('unknown message tag from page: "NotARealTag"')
    )
    handler.dispose()
  })

  it('round-trips via Schema.parseJson — encoded message decodes back to the same shape', () => {
    const original = { _tag: 'RouteChanged', pathname: '/p', canGoBack: true } as const
    const encoded = Schema.encodeSync(RouteChanged)(original)
    const decoded = Schema.decodeSync(RouteChanged)(encoded)
    expect(decoded).toEqual(original)

    // Sanity-check: the same schema round-trips a NativeBackRequested.
    const back = { _tag: 'NativeBackRequested' } as const
    expect(
      Schema.decodeSync(NativeBackRequested)(Schema.encodeSync(NativeBackRequested)(back))
    ).toEqual(back)
  })
})
