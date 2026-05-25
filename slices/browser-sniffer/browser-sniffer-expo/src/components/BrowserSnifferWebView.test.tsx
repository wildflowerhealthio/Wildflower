import { act, render } from '@testing-library/react-native'
import { Effect } from 'effect'
import type { Effect as EffectType, Layer as LayerType } from 'effect'
import * as React from 'react'
import type { ReactElement } from 'react'
import { Text } from 'react-native'

import {
  BrowserSnifferWebView,
  type BrowserSnifferWebViewHandle,
  type SnifferHandlers,
} from './BrowserSnifferWebView.tsx'

/** No-op handlers satisfying the full `HandlersFor<...>` shape so tests don't need to enumerate every tag. */
const noopHandlers: SnifferHandlers = {
  ResponseStart: () => Effect.void,
  ResponseData: () => Effect.void,
  ResponseFinished: () => Effect.void,
  RequestError: () => Effect.void,
  Cancelled: () => Effect.void,
  PageLoaded: () => Effect.void,
}

// Capture WebView props on each render so assertions can inspect what
// the component handed down (ref callback, source, onLoadEnd, the
// injected sniffer script, etc.) without needing the native runtime.
let mockLastWebViewProps:
  | (Record<string, unknown> & {
      readonly source?: { readonly uri?: string; readonly html?: string }
      readonly onLoadEnd?: (event: unknown) => void
      readonly onMessage?: (event: unknown) => void
      readonly injectedJavaScriptBeforeContentLoaded?: string
      readonly ref?: ((wv: { postMessage(s: string): void } | null) => void) | object
    })
  | null = null

const mockPostMessage = jest.fn<void, [string]>()

// Stub `react-native-webview` — the real module loads native modules
// that don't exist in jest-expo's JSDOM-ish environment.
jest.mock('react-native-webview', () => {
  const ReactInner = jest.requireActual<typeof React>('react')
  return {
    WebView: ReactInner.forwardRef(function MockWebView(
      props: Record<string, unknown>,
      ref: unknown
    ): ReactElement {
      mockLastWebViewProps = props
      const instance = { postMessage: mockPostMessage }
      // Attach to whatever ref shape the parent supplied. Callback
      // refs are used by BrowserSnifferWebView; object refs are
      // tolerated for completeness.
      if (typeof ref === 'function') {
        ref(instance)
      } else if (ref !== null && typeof ref === 'object' && 'current' in ref) {
        ;(ref as { current: unknown }).current = instance
      }
      return ReactInner.createElement('MockWebView', props)
    }),
  }
})

// Stub the injected sniffer script — we only need to verify the
// component pipes a string into `injectedJavaScriptBeforeContentLoaded`,
// not that the real installSniffer body lives there.
jest.mock('browser-sniffer-injected', () => ({
  snifferScript: '/* mock sniffer */',
  installSniffer: (): void => undefined,
  SNIFFER_STATE_KEY: Symbol.for('browser-sniffer:state'),
}))

// Stub the bridge so the component can construct a transport without
// pulling in the full effect-messaging machinery. The transport calls
// will go through the real BridgeTransport (we don't mock that) but
// the bridge's ReceiverLayer just needs to be callable.
jest.mock('browser-sniffer-core/bridge', () => {
  const effect = jest.requireActual<{ Effect: typeof EffectType; Layer: typeof LayerType }>(
    'effect'
  )
  return {
    __esModule: true,
    default: {
      name: 'BrowserSniffer',
      Web: { InboundSchemas: {}, OutboundSchemas: {} },
      Host: {
        InboundSchemas: {},
        OutboundSchemas: { CancelSnifferRequest: { _tag: 'mock' } },
        // ReceiverLayer returns a Layer with no requirements; the
        // BridgeTransport composition expects one per bridge.
        ReceiverLayer: (_handlers: unknown): LayerType.Layer<never> =>
          effect.Layer.effectDiscard(effect.Effect.void),
      },
    },
  }
})

// Stub effect-messaging-core's BridgeTransport.make so the component
// can complete construction synchronously. The real transport is
// covered by browser-sniffer-core/tests/bridge.test.ts.
//
// LogBridge is mocked just enough for the component's static field
// access (`LogBridge.defaultHostReceiverLayer`) to resolve to a
// no-requirements Layer — the mock BridgeTransport.make doesn't
// actually consume the layer, but the call site dereferences the
// field at construction time.
let mockSendMessageCalls: Array<{ readonly _tag: string; readonly id?: string }> = []
let mockEnqueueCalls: string[] = []
let mockEnqueueShouldFail = false
jest.mock('effect-messaging-core', () => {
  const effect = jest.requireActual<{ Effect: typeof EffectType; Layer: typeof LayerType }>(
    'effect'
  )
  return {
    BridgeTransport: {
      make: (_config: unknown) =>
        effect.Effect.succeed({
          sendMessage: (msg: { _tag: string; id?: string }): EffectType.Effect<void> =>
            effect.Effect.sync(() => {
              mockSendMessageCalls.push(msg)
            }),
          enqueue: (raw: string): EffectType.Effect<void, Error> => {
            mockEnqueueCalls.push(raw)
            return mockEnqueueShouldFail
              ? effect.Effect.fail(new Error('mock enqueue failure'))
              : effect.Effect.void
          },
          flushed: effect.Effect.void,
        }),
    },
    LogBridge: {
      defaultHostReceiverLayer: effect.Layer.effectDiscard(effect.Effect.void),
    },
    TransportAdapter: { Type: undefined },
    MessageHandler: {},
  }
})

beforeEach(() => {
  mockLastWebViewProps = null
  mockPostMessage.mockReset()
  mockSendMessageCalls = []
  mockEnqueueCalls = []
  mockEnqueueShouldFail = false
})

describe('BrowserSnifferWebView', () => {
  it('renders a WebView with the injected sniffer script', () => {
    render(
      <BrowserSnifferWebView source={{ uri: 'https://example.test' }} handlers={noopHandlers} />
    )
    expect(mockLastWebViewProps?.injectedJavaScriptBeforeContentLoaded).toBe('/* mock sniffer */')
    expect(mockLastWebViewProps?.source).toEqual({ uri: 'https://example.test' })
  })

  describe('loader prop', () => {
    it('renders the loader overlay until WebView fires onLoadEnd', () => {
      const loader = <Text testID="bsw-loader">Loading</Text>
      const { queryByTestId } = render(
        <BrowserSnifferWebView
          source={{ uri: 'https://example.test' }}
          handlers={noopHandlers}
          loader={loader}
        />
      )
      expect(queryByTestId('bsw-loader')).not.toBeNull()
      // Simulate the WebView signalling first-load complete. Wrap in
      // `act` so the `setLoaded(true)` update commits before the next
      // assertion reads the tree — without it, React batches the state
      // update past the synchronous expect.
      const onLoadEnd = mockLastWebViewProps?.onLoadEnd
      expect(typeof onLoadEnd).toBe('function')
      act(() => {
        onLoadEnd?.({})
      })
      expect(queryByTestId('bsw-loader')).toBeNull()
    })

    it('omits the loader overlay when no `loader` prop is supplied', () => {
      const { queryByTestId } = render(
        <BrowserSnifferWebView source={{ uri: 'https://example.test' }} handlers={noopHandlers} />
      )
      expect(queryByTestId('bsw-loader')).toBeNull()
    })
  })

  describe('cancelRequest', () => {
    it('routes through transport.sendMessage once the transport is built', async () => {
      const ref = React.createRef<BrowserSnifferWebViewHandle>()
      render(
        <BrowserSnifferWebView
          ref={ref}
          source={{ uri: 'https://example.test' }}
          handlers={noopHandlers}
        />
      )
      // Give the useEffect a tick to build the transport.
      await new Promise((resolve) => setTimeout(resolve, 0))
      ref.current?.cancelRequest('r1')
      // Drain the runFork tick.
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(mockSendMessageCalls).toEqual([{ _tag: 'CancelSnifferRequest', id: 'r1' }])
    })

    it('silently drops when called after the transport has been torn down', () => {
      // RTL's `render` commits effects synchronously, so there is no
      // observable "pre-build" window from a test's perspective. The
      // realistic defensive path is post-unmount: the cleanup nulls
      // `transportRef.current`, and a late `cancelRequest` becomes a
      // no-op rather than crashing the host. That's what this pins.
      const ref = React.createRef<BrowserSnifferWebViewHandle>()
      const { unmount } = render(
        <BrowserSnifferWebView
          ref={ref}
          source={{ uri: 'https://example.test' }}
          handlers={noopHandlers}
        />
      )
      unmount()
      mockSendMessageCalls = []
      expect(() => ref.current?.cancelRequest('r-post-unmount')).not.toThrow()
      expect(mockSendMessageCalls).toEqual([])
    })
  })

  describe('onMessage', () => {
    it('forwards WebView message data through transport.enqueue', async () => {
      render(
        <BrowserSnifferWebView source={{ uri: 'https://example.test' }} handlers={noopHandlers} />
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
      const onMessage = mockLastWebViewProps?.onMessage
      expect(typeof onMessage).toBe('function')
      onMessage?.({ nativeEvent: { data: '{"_tag":"Log","level":"info","payload":["hi"]}' } })
      expect(mockEnqueueCalls).toEqual(['{"_tag":"Log","level":"info","payload":["hi"]}'])
    })

    it('does not throw when transport.enqueue fails (failure is logged via catchAllCause)', async () => {
      mockEnqueueShouldFail = true
      render(
        <BrowserSnifferWebView source={{ uri: 'https://example.test' }} handlers={noopHandlers} />
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
      const onMessage = mockLastWebViewProps?.onMessage
      expect(() =>
        onMessage?.({ nativeEvent: { data: '{"_tag":"Log","level":"info","payload":["hi"]}' } })
      ).not.toThrow()
    })

    it('silently drops messages received after the transport has been torn down', () => {
      // RTL's `render` commits effects synchronously, so there is no
      // observable "pre-build" window. The realistic defensive path
      // is post-unmount: the cleanup nulls `transportRef.current`, and
      // a late inbound `message` event becomes a no-op rather than a
      // rejected promise.
      const { unmount } = render(
        <BrowserSnifferWebView source={{ uri: 'https://example.test' }} handlers={noopHandlers} />
      )
      const onMessage = mockLastWebViewProps?.onMessage
      unmount()
      mockEnqueueCalls = []
      expect(() =>
        onMessage?.({
          nativeEvent: { data: '{"_tag":"Log","level":"info","payload":["after-unmount"]}' },
        })
      ).not.toThrow()
      expect(mockEnqueueCalls).toEqual([])
    })
  })
})
