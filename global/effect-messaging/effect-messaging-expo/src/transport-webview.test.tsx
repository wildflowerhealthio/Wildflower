import { act, render } from '@testing-library/react-native'
import { Effect } from 'effect'
import type { BareSenderService } from 'effect-messaging-core'
import * as React from 'react'
import { View } from 'react-native'
import type * as RNType from 'react-native'

// `mock`-prefix is required for jest factory hoist (babel-plugin-jest-hoist matches /^mock/i).
type MockWebViewProps = {
  readonly source?: unknown
  readonly onMessage?: (event: unknown) => void
  readonly onLoadEnd?: () => void
  readonly onShouldStartLoadWithRequest?: (req: { url: string }) => boolean
}
let mockWebViewProps: MockWebViewProps | null = null
let mockExternalUrls: string[] = []
let mockWebViewPostMessageCalls: string[] = []

jest.mock('react-native-webview', () => {
  // Mock keeps `useImperativeHandle` so the postMessage path is exercised end-to-end.
  // Tests of pre-mount guards should use a separate dedicated mock.
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

import { TransportWebView } from './transport-webview.tsx'

beforeEach(() => {
  mockWebViewProps = null
  mockExternalUrls = []
  mockWebViewPostMessageCalls = []
})

describe('TransportWebView (transport surface)', () => {
  it('forwards source and onMessage to the underlying WebView', () => {
    const onMessage = jest.fn()
    render(<TransportWebView source={{ html: '<!doctype html>' }} onMessage={onMessage} />)
    expect(mockWebViewProps?.source).toEqual({ html: '<!doctype html>' })
    expect(mockWebViewProps?.onMessage).toBe(onMessage)
  })

  it('keeps same-origin navigations in-WebView and routes cross-origin to the system browser', () => {
    render(
      <TransportWebView
        source={{ html: '', baseUrl: 'https://app.local/?boot=1' }}
        onMessage={jest.fn()}
      />
    )
    const onShouldStartLoadWithRequest = mockWebViewProps?.onShouldStartLoadWithRequest
    if (onShouldStartLoadWithRequest === undefined)
      throw new Error('onShouldStartLoadWithRequest not captured')
    // Bootstrap navigations the WebView issues for inline HTML.
    expect(onShouldStartLoadWithRequest({ url: 'about:blank' })).toBe(true)
    // Same origin but different path/query (e.g. `window.location.href = '${origin}/apps/x'`).
    expect(onShouldStartLoadWithRequest({ url: 'https://app.local/apps/x' })).toBe(true)
    // Cross-origin link → external browser.
    expect(onShouldStartLoadWithRequest({ url: 'https://example.com' })).toBe(false)
    expect(mockExternalUrls).toEqual(['https://example.com'])
  })

  it('routes every non-bootstrap navigation externally when source has no resolvable origin', () => {
    render(<TransportWebView source={{ html: '' }} onMessage={jest.fn()} />)
    const onShouldStartLoadWithRequest = mockWebViewProps?.onShouldStartLoadWithRequest
    if (onShouldStartLoadWithRequest === undefined)
      throw new Error('onShouldStartLoadWithRequest not captured')
    expect(onShouldStartLoadWithRequest({ url: 'about:blank' })).toBe(true)
    expect(onShouldStartLoadWithRequest({ url: 'https://example.com' })).toBe(false)
    expect(mockExternalUrls).toEqual(['https://example.com'])
  })

  it('hands bareSender strings through to the underlying WebView ref', () => {
    const ref = React.createRef<BareSenderService>()
    render(<TransportWebView ref={ref} source={{ html: '' }} onMessage={jest.fn()} />)
    const sender = ref.current
    if (sender === null) throw new Error('ref.current not populated')
    Effect.runSync(sender.bareSender('payload-A'))
    Effect.runSync(sender.bareSender('payload-B'))
    expect(mockWebViewPostMessageCalls).toEqual(['payload-A', 'payload-B'])
  })

  it('hides the loader once onLoadEnd fires', () => {
    const { queryByTestId } = render(
      <TransportWebView
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
