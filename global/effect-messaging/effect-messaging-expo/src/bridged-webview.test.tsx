import { act, render, waitFor } from '@testing-library/react-native'
import { Effect, Schema } from 'effect'
import { Bridge, type BridgeTransport, type HostBinding } from 'effect-messaging-core'
import { makeBridgeDispatcher } from 'effect-messaging-react'
import * as React from 'react'
import type * as RNType from 'react-native'

// Hoisted module-scoped captures the mocked `react-native-webview`
// populates on each render — the `mock` prefix is required for
// babel-plugin-jest-hoist to leave them alone.
type MockWebViewProps = {
  readonly source?: { html?: string; baseUrl?: string; uri?: string }
  readonly onMessage?: (event: { nativeEvent: { data: string } }) => void
  readonly onLoadEnd?: () => void
}
let mockWebViewProps: MockWebViewProps | null = null
let mockPostMessageCalls: string[] = []

jest.mock('react-native-webview', () => {
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
          mockPostMessageCalls.push(data)
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

// `BridgedWebView` wraps the WebView in `SafeAreaView`; the real
// provider machinery isn't needed for this transport-level test.
jest.mock('react-native-safe-area-context', () => {
  const RN = jest.requireActual<typeof RNType>('react-native')
  return { SafeAreaView: RN.View }
})

import { makeBridgedWebView } from './bridged-webview.tsx'

// Test fixture bridge: one host→web tag and one web→host tag, both
// schema-encoded as JSON tagged structs (the wire format the dispatch
// core understands).
const PingSchema = Schema.parseJson(Schema.TaggedStruct('Ping', { value: Schema.String }))
const PongSchema = Schema.parseJson(Schema.TaggedStruct('Pong', { reply: Schema.String }))

const PingPongBridge = Bridge.make({
  name: 'PingPong',
  hostToWeb: [['Ping', PingSchema]] as const,
  webToHost: [['Pong', PongSchema]] as const,
})

beforeEach(() => {
  mockWebViewProps = null
  mockPostMessageCalls = []
})

describe('BridgedWebView (integration)', () => {
  it('completes the __Ready handshake and round-trips messages in both directions', async () => {
    // Closes over `pongCalls` and `capturedSend` so the test can
    // observe both directions of the dispatch.
    const pongCalls: Array<{ readonly reply: string }> = []
    let capturedSend: BridgeTransport.MessageSender<
      readonly [typeof PingPongBridge],
      'Host'
    > | null = null

    const binding: HostBinding.HostBinding<typeof PingPongBridge> = {
      bridge: PingPongBridge,
      receiverLayer: PingPongBridge.Host.ReceiverLayer({
        Pong: ({ reply }) => Effect.sync(() => pongCalls.push({ reply })),
      }),
      onTransportReady: (send) =>
        Effect.sync(() => {
          capturedSend = send
        }),
    }

    const bindings = [binding] as const
    const { BridgeDispatchRegistryProvider } = makeBridgeDispatcher(
      'PingPong',
      [PingPongBridge] as const,
      'Host'
    )
    const BridgedWebView = makeBridgedWebView(bindings, BridgeDispatchRegistryProvider)

    render(
      <BridgedWebView
        loadFrom={{ _tag: 'html', html: '<!doctype html><html></html>' } as const}
        baseUrl="https://app.test/"
      />
    )

    // The WebView mounts after `BridgedWebView`'s `useEffect` runs the
    // forked transport build and calls `setTransport(built)`. Polling
    // here avoids depending on the specific microtask shape.
    await waitFor(() => {
      expect(mockWebViewProps).not.toBeNull()
    })

    // `useTransportReadyCaller`'s `useEffect` forks each binding's
    // `onTransportReady`; ours captures the host sender.
    await waitFor(() => {
      expect(capturedSend).not.toBeNull()
    })

    // === Page → Host: __Ready handshake ===
    // The production wiring previously passed `transport.onMessage`
    // (which returns an Effect) straight into react-native-webview's
    // sync `void` callback; every Effect was constructed and discarded
    // — including this `__Ready`. Without that, the host's `peerReady`
    // never resolves and the next step would hang forever.
    const onMessage = mockWebViewProps?.onMessage
    if (onMessage === undefined) throw new Error('onMessage prop not captured')
    act(() => {
      onMessage({ nativeEvent: { data: '{"_tag":"__Ready"}' } })
    })

    // === Host → Page: send Ping (gated on __Ready) ===
    await act(async () => {
      // Narrow inside the closure — TS conservatively widens `let`
      // variables across async-closure boundaries.
      const send = capturedSend
      if (send === null) throw new Error('capturedSend not set')
      await Effect.runPromise(send({ _tag: 'Ping', value: 'hello' }))
    })

    await waitFor(() => {
      expect(mockPostMessageCalls).toEqual([JSON.stringify({ _tag: 'Ping', value: 'hello' })])
    })

    // === Page → Host: Pong reaches the receiver layer ===
    act(() => {
      onMessage({
        nativeEvent: { data: JSON.stringify({ _tag: 'Pong', reply: 'world' }) },
      })
    })

    await waitFor(() => {
      expect(pongCalls).toEqual([{ reply: 'world' }])
    })
  })

  it("encodes a binding's `initialMessages` into the WebView source URL", async () => {
    // Bridge with a urlParams schema so `appendMessagesToUrl` accepts
    // the initial message. Mirrors the production navigation binding's
    // role (seeds `HostRequestedWebNavigation` via URL query).
    const SetupSchema = Schema.parseJson(Schema.TaggedStruct('Setup', { path: Schema.String }))
    const BootBridge = Bridge.make({
      name: 'Boot',
      hostToWeb: [['Setup', SetupSchema]] as const,
      webToHost: [] as const,
      urlParams: {
        Setup: Schema.transform(Schema.String, Schema.typeSchema(Schema.parseJson(SetupSchema)), {
          decode: (path) => ({ _tag: 'Setup' as const, path }),
          encode: ({ path }) => path,
        }),
      },
    })

    const binding: HostBinding.HostBinding<typeof BootBridge> = {
      bridge: BootBridge,
      receiverLayer: BootBridge.Host.ReceiverLayer({}),
      initialMessages: [{ _tag: 'Setup', path: '/welcome' }],
    }

    const bindings = [binding] as const
    const { BridgeDispatchRegistryProvider } = makeBridgeDispatcher(
      'Boot',
      [BootBridge] as const,
      'Host'
    )
    const BridgedWebView = makeBridgedWebView(bindings, BridgeDispatchRegistryProvider)

    render(
      <BridgedWebView
        loadFrom={{ _tag: 'html', html: '<!doctype html><html></html>' } as const}
        baseUrl="https://app.test/"
      />
    )

    await waitFor(() => {
      expect(mockWebViewProps?.source?.baseUrl).toContain('Setup=%2Fwelcome')
    })
  })
})
