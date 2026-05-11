import { act, render } from '@testing-library/react-native'
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
  it('forwards source and onMessage to the underlying WebView', () => {
    const onMessage = jest.fn()
    render(<EffectMessagingWebView source={{ html: '<!doctype html>' }} onMessage={onMessage} />)
    expect(mockWebViewProps?.source).toEqual({ html: '<!doctype html>' })
    expect(mockWebViewProps?.onMessage).toBe(onMessage)
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
