/**
 * End-to-end coverage for `BrowserSnifferWebView` composing the real
 * `BridgedWebView` from `effect-messaging-expo` against a mocked
 * `react-native-webview`. Smoke-tests that:
 *
 * - the wrapper's binding wiring captures the typed sender via
 *   `onPageReady` (host-side `Click` reaches the WebView's
 *   `postMessage`),
 * - and an inbound `PageLoaded` wire message decodes through the real
 *   dispatch core and reaches the consumer's `browserSnifferHandlers`.
 *
 * Sibling file `BrowserSnifferWebView.test.tsx` covers the
 * mocked-BridgedWebView unit cases. Splitting the e2e out keeps the
 * `jest.mock('effect-messaging-expo')` factory hoist isolated to the
 * mocked file — bypassing it in-place would require
 * `--experimental-vm-modules` (jest's ESM gate for dynamic imports).
 */
import { act, render, waitFor } from '@testing-library/react-native'
import { Effect } from 'effect'
import type { Logging } from 'effect-messaging-core'
import * as React from 'react'
import type * as RNType from 'react-native'

// Per-suite capture of the mocked WebView's most recent props +
// every `postMessage` call. Stable references so the jest factory
// can capture them in its closure (the `mock`-prefix on
// `mockWebViewState` keeps babel-plugin-jest-hoist happy).
const mockWebViewState: {
  props: {
    onMessage?: (event: { nativeEvent: { data: string } }) => void
    source?: { html?: string; baseUrl?: string; uri?: string }
    injectedJavaScriptBeforeContentLoaded?: string
  } | null
  postMessageCalls: string[]
} = {
  props: null,
  postMessageCalls: [],
}

jest.mock('react-native-webview', () => {
  const ReactInner = jest.requireActual<typeof React>('react')
  const RN = jest.requireActual<typeof RNType>('react-native')
  const WebView = ReactInner.forwardRef(function MockWebView(
    props: typeof mockWebViewState.props & object,
    ref: React.Ref<{ postMessage: (data: string) => void }>
  ): React.ReactElement {
    mockWebViewState.props = props
    ReactInner.useImperativeHandle(
      ref,
      () => ({
        postMessage: (data: string): void => {
          mockWebViewState.postMessageCalls.push(data)
        },
      }),
      []
    )
    return ReactInner.createElement(RN.View, { testID: 'webview' })
  })
  return { WebView }
})

jest.mock('expo-web-browser', () => ({
  openBrowserAsync: jest.fn(() => Promise.resolve()),
}))

import {
  BrowserSnifferWebView,
  type BrowserSnifferMessageSender,
} from './BrowserSnifferWebView.tsx'

describe('BrowserSnifferWebView (e2e with real BridgedWebView)', () => {
  beforeEach(() => {
    mockWebViewState.props = null
    mockWebViewState.postMessageCalls.length = 0
  })

  it('round-trips a Click out and a PageLoaded in through the real transport', async () => {
    const snifferEvents: Array<{ readonly _tag: string }> = []
    const snifferHandlers = {
      Cancelled: () => Effect.void,
      PageLoaded: (msg: { readonly _tag: 'PageLoaded' }) =>
        Effect.sync(() => {
          snifferEvents.push(msg)
        }),
      RequestError: () => Effect.void,
      ResponseData: () => Effect.void,
      ResponseFinished: () => Effect.void,
      ResponseStart: () => Effect.void,
    } as const
    const ref = React.createRef<BrowserSnifferMessageSender>()
    render(
      <BrowserSnifferWebView
        ref={ref}
        loadFrom={{ _tag: 'uri', uri: 'https://patient.example.com/' }}
        browserSnifferHandlers={snifferHandlers}
      />
    )

    await waitFor(() => {
      if (mockWebViewState.props === null) throw new Error('WebView never mounted')
    })
    // `injectedJavaScriptBeforeContentLoaded` should arrive verbatim
    // via TransportWebView → react-native-webview. Locks in that the
    // wrapper isn't accidentally dropping it.
    expect(mockWebViewState.props?.injectedJavaScriptBeforeContentLoaded).toBeTruthy()
    const onMessage = mockWebViewState.props?.onMessage
    if (onMessage === undefined) throw new Error('onMessage prop not captured')

    // Page-side `__Ready` unblocks the host's sendMessage gate AND
    // (with the `onPageReady` rename) runs the sniffer binding's
    // sender-capture callback inside the inbound dispatcher.
    act(() => {
      onMessage({ nativeEvent: { data: '{"_tag":"__Ready"}' } })
    })
    // Inbound `PageLoaded` should reach the consumer's snifferHandler.
    // The inbox is FIFO single-fiber, so by the time the PageLoaded
    // handler runs, the preceding `__Ready` has fully drained through
    // the `onPageReady` control handler — the sender ref behind
    // `stableSender` is therefore guaranteed to be populated. Using
    // PageLoaded as the synchronisation point avoids racing the
    // Click against the dispatcher.
    act(() => {
      onMessage({
        nativeEvent: {
          data: JSON.stringify({
            _tag: 'PageLoaded',
            url: 'https://patient.example.com/',
            pageContentId: 'p1',
          }),
        },
      })
    })

    await waitFor(() => {
      expect(snifferEvents.map((e) => e._tag)).toContain('PageLoaded')
    })

    // Now safe: `__Ready` was processed before `PageLoaded` (FIFO),
    // so the sniffer binding's sender ref is captured. The Click goes
    // through the live transport to the WebView mock's postMessage log.
    await act(async () => {
      if (ref.current === null) throw new Error('ref.current not populated')
      await Effect.runPromise(ref.current({ _tag: 'Click', querySelector: '#go' }))
    })

    await waitFor(() => {
      expect(mockWebViewState.postMessageCalls).toEqual([
        JSON.stringify({ _tag: 'Click', querySelector: '#go' }),
      ])
    })
  })

  it('routes a Log wire message through onLog', async () => {
    const logEvents: Array<Logging.LogPayload> = []
    const onLog = (msg: Logging.LogPayload): Effect.Effect<void> =>
      Effect.sync(() => {
        logEvents.push(msg)
      })
    const snifferHandlers = {
      Cancelled: () => Effect.void,
      PageLoaded: () => Effect.void,
      RequestError: () => Effect.void,
      ResponseData: () => Effect.void,
      ResponseFinished: () => Effect.void,
      ResponseStart: () => Effect.void,
    } as const

    render(
      <BrowserSnifferWebView
        loadFrom={{ _tag: 'uri', uri: 'https://x/' }}
        onLog={onLog}
        browserSnifferHandlers={snifferHandlers}
      />
    )
    await waitFor(() => {
      if (mockWebViewState.props === null) throw new Error('WebView never mounted')
    })
    const onMessage = mockWebViewState.props?.onMessage
    if (onMessage === undefined) throw new Error('onMessage prop not captured')

    act(() => {
      onMessage({
        nativeEvent: {
          data: JSON.stringify({ _tag: 'Log', level: 'warn', payload: ['oops'] }),
        },
      })
    })

    await waitFor(() => {
      expect(logEvents).toEqual([{ _tag: 'Log', level: 'warn', payload: ['oops'] }])
    })
  })
})
