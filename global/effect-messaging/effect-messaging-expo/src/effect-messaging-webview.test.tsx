import { act, fireEvent, render } from '@testing-library/react-native'
import * as React from 'react'
import { View } from 'react-native'
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
let mockWebViewPostMessageCalls: string[] = []

jest.mock('react-native-webview', () => {
  // The mock implements `useImperativeHandle` with property-style (not
  // method-shorthand) so babel-plugin-jest-hoist doesn't flag inner
  // identifiers as out-of-scope. The captured state
  // `mockWebViewPostMessageCalls` keeps a `mock`-prefixed name to
  // satisfy the hoist exemption.
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

  it('does not set a headerLeft when canGoBack is omitted', () => {
    render(<EffectMessagingWebView source={{ html: '' }} onMessage={jest.fn()} />)
    expect(mockNavigationOptions.headerLeft).toBeUndefined()
  })

  it('sets a headerLeft that fires onBackPress when canGoBack flips to true', () => {
    const onBackPress = jest.fn()
    const { rerender } = render(
      <EffectMessagingWebView source={{ html: '' }} onMessage={jest.fn()} canGoBack={false} />
    )
    rerender(
      <EffectMessagingWebView
        source={{ html: '' }}
        onMessage={jest.fn()}
        canGoBack={true}
        onBackPress={onBackPress}
      />
    )
    const headerLeft = mockNavigationOptions.headerLeft as
      | ((tint: { tintColor?: string }) => React.ReactElement)
      | undefined
    if (headerLeft === undefined) throw new Error('headerLeft not set')
    const { getByLabelText } = render(headerLeft({ tintColor: '#000' }))
    fireEvent.press(getByLabelText('Back'))
    expect(onBackPress).toHaveBeenCalledTimes(1)
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
