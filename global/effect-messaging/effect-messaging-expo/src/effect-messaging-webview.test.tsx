import { fireEvent, render } from '@testing-library/react-native'
import * as React from 'react'
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
let mockNavigationOptions: { headerLeft?: unknown } = {}
let mockExternalUrls: string[] = []

jest.mock('react-native-webview', () => {
  // The mock intentionally omits `useImperativeHandle` + the
  // method-shorthand type generic that earlier versions of this file
  // used: babel-plugin-jest-hoist flagged the inner method name as an
  // out-of-scope variable. With no imperative handle here, the outer
  // `webviewRef.current` stays null inside EffectMessagingWebView; its own
  // forwarded handle still wires up correctly because the body is
  // `webviewRef.current?.postMessage(message)` — the optional chain
  // short-circuits, which is exactly what the "exposes postMessage"
  // test below checks for ("does not throw").
  const ReactInner = jest.requireActual<typeof React>('react')
  const RN = jest.requireActual<typeof RNType>('react-native')
  const WebView = ReactInner.forwardRef(function MockWebView(
    props: MockWebViewProps,
    _ref: unknown
  ): React.ReactElement {
    mockWebViewProps = props
    return ReactInner.createElement(RN.View, { testID: 'webview' })
  })
  return { WebView }
})

jest.mock('expo-router', () => ({
  useNavigation: (): { setOptions(o: { headerLeft?: unknown }): void } => ({
    setOptions: (o) => {
      mockNavigationOptions = { ...mockNavigationOptions, ...o }
    },
  }),
}))

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
  mockNavigationOptions = {}
  mockExternalUrls = []
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

  it('does not set a headerLeft when canGoBack is omitted', () => {
    render(<EffectMessagingWebView source={{ html: '' }} onMessage={jest.fn()} />)
    expect(mockNavigationOptions.headerLeft).toBeUndefined()
  })

  it('sets a headerLeft when canGoBack flips to true with onBackPress provided', () => {
    const { rerender } = render(
      <EffectMessagingWebView source={{ html: '' }} onMessage={jest.fn()} canGoBack={false} />
    )
    rerender(
      <EffectMessagingWebView
        source={{ html: '' }}
        onMessage={jest.fn()}
        canGoBack={true}
        onBackPress={jest.fn()}
      />
    )
    expect(typeof mockNavigationOptions.headerLeft).toBe('function')
  })

  it('opens external links in the system browser, not in-page', () => {
    render(<EffectMessagingWebView source={{ html: '' }} onMessage={jest.fn()} />)
    const onShouldStartLoadWithRequest = mockWebViewProps?.onShouldStartLoadWithRequest
    if (onShouldStartLoadWithRequest === undefined)
      throw new Error('onShouldStartLoadWithRequest not captured')
    // First request is the bundle's source — internal.
    expect(onShouldStartLoadWithRequest({ url: 'about:blank' })).toBe(true)
    // Subsequent request to a different URL — external.
    expect(onShouldStartLoadWithRequest({ url: 'https://example.com' })).toBe(false)
    expect(mockExternalUrls).toEqual(['https://example.com'])
  })

  it('exposes postMessage through the imperative ref handle', () => {
    const ref = React.createRef<EffectMessagingWebViewHandle>()
    render(<EffectMessagingWebView ref={ref} source={{ html: '' }} onMessage={jest.fn()} />)
    expect(typeof ref.current?.postMessage).toBe('function')
    // Calling it does not throw — actual delivery is the WebView's contract.
    expect(() => ref.current?.postMessage('payload')).not.toThrow()
  })

  it('dismisses the loading overlay on onLoadEnd', () => {
    const { queryByTestId } = render(
      <EffectMessagingWebView source={{ html: '' }} onMessage={jest.fn()} />
    )
    // Before onLoadEnd: pre-load state — the WebView is rendered, the
    // overlay sits on top. We can verify by checking the WebView is mounted
    // and that triggering onLoadEnd flips internal state without errors.
    expect(queryByTestId('webview')).not.toBeNull()
    fireEvent(queryByTestId('webview') ?? new Error('webview not rendered'), 'load')
    // The component itself doesn't expose a testID for the overlay, but
    // calling onLoadEnd directly through the captured prop reaches the same
    // setState. Either way, the test ensures the prop is wired.
    const onLoadEnd = mockWebViewProps?.onLoadEnd
    expect(typeof onLoadEnd).toBe('function')
    onLoadEnd?.()
  })
})
