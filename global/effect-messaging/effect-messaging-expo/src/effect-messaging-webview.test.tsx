import { act, fireEvent, render } from '@testing-library/react-native'
import * as React from 'react'
import { Pressable, Text, View } from 'react-native'
import type * as RNType from 'react-native'

// `jest.mock` factories are hoisted above imports and forbidden to read
// out-of-scope variables. babel-plugin-jest-hoist exempts identifiers
// matching `/^mock/i`, so every captured-state variable below uses a bare
// `mock` prefix (no leading underscores — `__mockX` would not match).
type MockWebViewProps = {
  readonly source?: unknown
  readonly injectedJavaScriptBeforeContentLoaded?: string
  readonly onMessage?: (event: unknown) => void
  readonly onLoadEnd?: () => void
  readonly onShouldStartLoadWithRequest?: (req: { url: string }) => boolean
}
let mockWebViewProps: MockWebViewProps | null = null
let mockExternalUrls: string[] = []
let mockWebViewPostMessageCalls: string[] = []

jest.mock('react-native-webview', () => {
  // The mock implements `useImperativeHandle` so `webviewRef.current`
  // resolves and the EffectMessagingWebView's own
  // `useImperativeHandle` proxies through to a real spy. The captured
  // state `mockWebViewPostMessageCalls` keeps a `mock`-prefixed name to
  // satisfy the babel-plugin-jest-hoist exemption.
  //
  // Trade-off note for thread 3210720124: this mock keeps
  // `useImperativeHandle` so the imperative postMessage path is
  // exercised end-to-end. When a future test wants to verify behaviour
  // without an imperative handle (e.g. asserting the optional-chain
  // guard pre-mount), use a separate test that intentionally omits
  // `useImperativeHandle` rather than the global mock.
  const ReactInner = jest.requireActual<typeof React>('react')
  const RN = jest.requireActual<typeof RNType>('react-native')
  const WebView = ReactInner.forwardRef(function MockWebView(
    props: MockWebViewProps,
    ref: React.Ref<{ postMessage: (data: string) => void }>
  ): React.ReactElement {
    mockWebViewProps = props
    ReactInner.useImperativeHandle(
      ref,
      () => ({
        postMessage: (data: string): void => {
          mockWebViewPostMessageCalls.push(data)
        },
      }),
      []
    )
    return ReactInner.createElement(RN.View, { testID: 'webview' })
  })
  return { WebView }
})

jest.mock('expo-web-browser', () => ({
  openBrowserAsync: jest.fn((url: string) => {
    mockExternalUrls.push(url)
    return Promise.resolve()
  }),
}))

import {
  EffectMessagingWebView,
  type EffectMessagingWebViewHandle,
} from './effect-messaging-webview.tsx'

beforeEach(() => {
  mockWebViewProps = null
  mockExternalUrls = []
  mockWebViewPostMessageCalls = []
})

describe('EffectMessagingWebView (transport surface)', () => {
  it('forwards source, injectedScript, and onMessage to the underlying WebView', () => {
    const onMessage = jest.fn()
    render(
      <EffectMessagingWebView
        source={{ html: '<!doctype html>' }}
        injectedScript="window.__X__ = 1; true;"
        onMessage={onMessage}
      />
    )
    expect(mockWebViewProps?.source).toEqual({ html: '<!doctype html>' })
    expect(mockWebViewProps?.injectedJavaScriptBeforeContentLoaded).toBe('window.__X__ = 1; true;')
    expect(mockWebViewProps?.onMessage).toBe(onMessage)
  })

  it('forwards a headerLeft renderer to the consumer-supplied setHeaderLeft', () => {
    const onBackPress = jest.fn()
    let captured: ((args: { tintColor?: string }) => React.ReactNode) | undefined
    const setHeaderLeft = (
      r: ((args: { tintColor?: string }) => React.ReactNode) | undefined
    ): void => {
      captured = r
    }
    const headerLeft = ({ tintColor }: { tintColor?: string }): React.ReactElement => (
      <Pressable onPress={onBackPress} accessibilityLabel="Back" hitSlop={12}>
        <Text style={tintColor ? { color: tintColor } : undefined}>Back</Text>
      </Pressable>
    )
    render(
      <EffectMessagingWebView
        source={{ html: '' }}
        onMessage={jest.fn()}
        setHeaderLeft={setHeaderLeft}
        headerLeft={headerLeft}
      />
    )
    if (captured === undefined) throw new Error('headerLeft renderer not captured')
    const { getByLabelText } = render(<>{captured({ tintColor: '#000' })}</>)
    fireEvent.press(getByLabelText('Back'))
    expect(onBackPress).toHaveBeenCalledTimes(1)
  })

  it('clears the consumer-supplied headerLeft on unmount', () => {
    let captured: ((args: { tintColor?: string }) => React.ReactNode) | undefined = undefined
    const setHeaderLeft = (
      r: ((args: { tintColor?: string }) => React.ReactNode) | undefined
    ): void => {
      captured = r
    }
    const { unmount } = render(
      <EffectMessagingWebView
        source={{ html: '' }}
        onMessage={jest.fn()}
        setHeaderLeft={setHeaderLeft}
        headerLeft={() => null}
      />
    )
    expect(captured).toBeDefined()
    unmount()
    expect(captured).toBeUndefined()
  })

  it('opens external links in the system browser, not in-page', () => {
    render(<EffectMessagingWebView source={{ html: '' }} onMessage={jest.fn()} />)
    const onShouldStartLoadWithRequest = mockWebViewProps?.onShouldStartLoadWithRequest
    if (onShouldStartLoadWithRequest === undefined)
      throw new Error('onShouldStartLoadWithRequest not captured')
    expect(onShouldStartLoadWithRequest({ url: 'about:blank' })).toBe(true)
    expect(onShouldStartLoadWithRequest({ url: 'https://example.com' })).toBe(false)
    expect(mockExternalUrls).toEqual(['https://example.com'])
  })

  it('hands postMessage strings through to the underlying WebView ref', () => {
    const ref = React.createRef<EffectMessagingWebViewHandle>()
    render(<EffectMessagingWebView ref={ref} source={{ html: '' }} onMessage={jest.fn()} />)
    ref.current?.postMessage('payload-A')
    ref.current?.postMessage('payload-B')
    expect(mockWebViewPostMessageCalls).toEqual(['payload-A', 'payload-B'])
  })

  it('hides the loader once onLoadEnd fires', () => {
    const { queryByTestId } = render(
      <EffectMessagingWebView
        source={{ html: '' }}
        onMessage={jest.fn()}
        loader={<View testID="loader-overlay" />}
      />
    )
    expect(queryByTestId('loader-overlay')).not.toBeNull()
    const onLoadEnd = mockWebViewProps?.onLoadEnd
    if (onLoadEnd === undefined) throw new Error('onLoadEnd not captured')
    act(() => {
      onLoadEnd()
    })
    expect(queryByTestId('loader-overlay')).toBeNull()
  })
})
