import { act, render } from '@testing-library/react-native'
import { Effect } from 'effect'
import type { BareSenderFunction } from 'effect-messaging-core'
import * as React from 'react'
import { View } from 'react-native'
import {
  mockWebViewModuleFactory,
  mockWebViewState,
  resetMockWebView,
} from './test/mock-webview.ts'

// `mock`-prefix is required for jest factory hoist
// (babel-plugin-jest-hoist matches `/^mock/i`). `mockWebViewModuleFactory`
// satisfies the rule so the factory can reference the helper after
// the `jest.mock` call is hoisted to the top of the module.
jest.mock('react-native-webview', () => mockWebViewModuleFactory())

// Co-located with the suite — only this test exercises the
// `openBrowserAsync` external-link path.
let mockExternalUrls: string[] = []
jest.mock('expo-web-browser', () => ({
  openBrowserAsync: jest.fn((url: string) => {
    mockExternalUrls.push(url)
    return Promise.resolve()
  }),
}))

import { TransportWebView } from './transport-webview.tsx'

beforeEach(() => {
  resetMockWebView()
  mockExternalUrls = []
})

describe('TransportWebView (transport surface)', () => {
  it('forwards source and onMessage to the underlying WebView', () => {
    const onMessage = jest.fn()
    render(<TransportWebView source={{ html: '<!doctype html>' }} onMessage={onMessage} />)
    expect(mockWebViewState.props?.source).toEqual({ html: '<!doctype html>' })
    expect(mockWebViewState.props?.onMessage).toBe(onMessage)
  })

  it('keeps every navigation in-WebView by default (no shouldOpenInSystemBrowser)', () => {
    render(
      <TransportWebView
        source={{ html: '', baseUrl: 'https://app.local/?boot=1' }}
        onMessage={jest.fn()}
      />
    )
    const onShouldStartLoadWithRequest = mockWebViewState.props?.onShouldStartLoadWithRequest
    if (onShouldStartLoadWithRequest === undefined)
      throw new Error('onShouldStartLoadWithRequest not captured')
    // Bootstrap navigations the WebView issues for inline HTML.
    expect(onShouldStartLoadWithRequest({ url: 'about:blank' })).toBe(true)
    // Same-origin and cross-origin both stay in-WebView when no
    // routing predicate is supplied — there is no implicit
    // same-origin gate.
    expect(onShouldStartLoadWithRequest({ url: 'https://app.local/apps/x' })).toBe(true)
    expect(onShouldStartLoadWithRequest({ url: 'https://example.com' })).toBe(true)
    expect(mockExternalUrls).toEqual([])
  })

  it('routes URLs through the system browser when shouldOpenInSystemBrowser returns true', () => {
    const externalHosts = new Set(['example.com'])
    render(
      <TransportWebView
        source={{ html: '' }}
        onMessage={jest.fn()}
        shouldOpenInSystemBrowser={(url) => externalHosts.has(new URL(url).hostname)}
      />
    )
    const onShouldStartLoadWithRequest = mockWebViewState.props?.onShouldStartLoadWithRequest
    if (onShouldStartLoadWithRequest === undefined)
      throw new Error('onShouldStartLoadWithRequest not captured')
    expect(onShouldStartLoadWithRequest({ url: 'about:blank' })).toBe(true)
    expect(onShouldStartLoadWithRequest({ url: 'https://app.local/x' })).toBe(true)
    expect(onShouldStartLoadWithRequest({ url: 'https://example.com' })).toBe(false)
    expect(mockExternalUrls).toEqual(['https://example.com'])
  })

  it('hands bareSender strings through to the underlying WebView ref', () => {
    const ref = React.createRef<BareSenderFunction>()
    render(<TransportWebView ref={ref} source={{ html: '' }} onMessage={jest.fn()} />)
    const sender = ref.current
    if (sender === null) throw new Error('ref.current not populated')
    Effect.runSync(sender('payload-A'))
    Effect.runSync(sender('payload-B'))
    expect(mockWebViewState.postMessageCalls).toEqual(['payload-A', 'payload-B'])
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
    const onLoadEnd = mockWebViewState.props?.onLoadEnd
    if (onLoadEnd === undefined) throw new Error('onLoadEnd not captured')
    act(() => {
      onLoadEnd()
    })
    expect(queryByTestId('loader-overlay')).toBeNull()
  })
})
