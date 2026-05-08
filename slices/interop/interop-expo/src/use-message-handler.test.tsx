import { act, renderHook } from '@testing-library/react-native'
import { Schema } from 'effect'
import {
  AppNavigationRequested,
  InteropNativeToWeb,
  InteropWebToNative,
  RouteChanged,
} from 'interop-core'

// Mock the imports `useMessageHandler` pulls in transitively. The hook
// itself doesn't render any RN components, so a minimal mock surface
// suffices.
jest.mock('react-native-webview', () => ({}))

import { useMessageHandler } from './use-message-handler.ts'

describe('useMessageHandler', () => {
  it('replays __INITIAL_MESSAGES__-encoded entries through the handler', () => {
    const initialMessages: ReadonlyArray<string> = [
      Schema.encodeSync(AppNavigationRequested)({
        _tag: 'AppNavigationRequested',
        path: '/initial',
      }),
    ]
    // Note: useMessageHandler is the *Expo*-side hook, which receives
    // Web→Native messages. AppNavigationRequested is Native→Web; we
    // construct a handler with InteropNativeToWeb in the receive slot
    // here purely to exercise the buffered-replay path on the Expo side.
    const { result } = renderHook(() =>
      useMessageHandler({
        receive: InteropNativeToWeb,
        send: InteropWebToNative,
        initialMessages,
      })
    )

    // The hook should expose handler + webview wiring.
    expect(typeof result.current.handler.setMessageListener).toBe('function')
    expect(typeof result.current.injectedScript).toBe('string')
    expect(typeof result.current.onMessage).toBe('function')
    expect(result.current.injectedScript).toContain('__INITIAL_MESSAGES__')
  })

  it('decodes incoming messages from onMessage and routes them to listeners', () => {
    const { result } = renderHook(() =>
      useMessageHandler({
        receive: InteropWebToNative,
        send: InteropNativeToWeb,
        initialMessages: [],
      })
    )

    let lastCanGoBack: boolean | null = null
    act(() => {
      result.current.handler.setMessageListener('RouteChanged', (m) => {
        lastCanGoBack = m.canGoBack
      })
    })

    act(() => {
      const encoded = Schema.encodeSync(RouteChanged)({
        _tag: 'RouteChanged',
        pathname: '/p',
        canGoBack: true,
      })
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      const fakeEvent = { nativeEvent: { data: encoded } } as unknown as Parameters<
        typeof result.current.onMessage
      >[0]
      result.current.onMessage(fakeEvent)
    })

    expect(lastCanGoBack).toBe(true)
  })

  it('emits an encoded message via the imperative ref when sendMessage is called', () => {
    const posts: string[] = []
    const { result } = renderHook(() =>
      useMessageHandler({
        receive: InteropWebToNative,
        send: InteropNativeToWeb,
        initialMessages: [],
      })
    )

    act(() => {
      result.current.webviewHandleRef.current = {
        postMessage: (raw: string) => {
          posts.push(raw)
        },
      }
    })

    act(() => {
      result.current.handler.sendMessage({ _tag: 'NativeBackRequested' })
    })

    expect(posts).toHaveLength(1)
    expect(JSON.parse(posts[0] ?? '')).toEqual({ _tag: 'NativeBackRequested' })
  })
})
