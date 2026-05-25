import { act, render, waitFor } from '@testing-library/react-native'
import { Effect, Schema } from 'effect'
import { Bridge, type BridgeTransport, type HostBinding } from 'effect-messaging-core'
import { makeBridgeDispatcher } from 'effect-messaging-react'
import type * as RNType from 'react-native'
import {
  mockWebViewModuleFactory,
  mockWebViewState,
  resetMockWebView,
} from './test/mock-webview.ts'

// `mock`-prefix is required for jest factory hoist
// (babel-plugin-jest-hoist matches `/^mock/i`). `mockWebViewModuleFactory`
// satisfies the rule so the factory can reference the helper after
// `jest.mock` is hoisted to the top of the module.
jest.mock('react-native-webview', () => mockWebViewModuleFactory())

jest.mock('expo-web-browser', () => ({
  openBrowserAsync: jest.fn(() => Promise.resolve()),
}))

// `BridgedWebView` wraps the WebView in `SafeAreaView`; the real
// provider machinery isn't needed for this transport-level test.
jest.mock('react-native-safe-area-context', () => {
  const RN = jest.requireActual<typeof RNType>('react-native')
  return { SafeAreaView: RN.View }
})

import { BridgedWebView } from './bridged-webview.tsx'

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

type PingPongBindings = readonly [HostBinding.HostBinding<typeof PingPongBridge>]
type PingPongSend = BridgeTransport.MessageSender<readonly [typeof PingPongBridge], 'Host'>

describe('BridgedWebView (integration)', () => {
  // Per-test captures populated by `beforeEach`. The shared setup
  // builds the binding (with `pongCalls` + `capturedSend` captures),
  // the registry provider, and renders the host shell. Each `it()`
  // block exercises one slice of the handshake / round-trip sequence
  // against this baseline.
  let pongCalls: Array<{ readonly reply: string }>
  let capturedSend: PingPongSend | null

  beforeEach(async () => {
    resetMockWebView()
    pongCalls = []
    capturedSend = null

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

    const bindings: PingPongBindings = [binding]
    const { BridgeDispatchRegistryProvider } = makeBridgeDispatcher(
      'PingPong',
      [PingPongBridge] as const,
      'Host'
    )

    render(
      <BridgedWebView<PingPongBindings>
        bindings={bindings}
        BridgeDispatchRegistryProvider={BridgeDispatchRegistryProvider}
        loadFrom={{ _tag: 'html', html: '<!doctype html><html></html>' } as const}
        baseUrl="https://app.test/"
      />
    )

    // Wait for the WebView to mount so individual tests can grab
    // `mockWebViewState.props?.onMessage` immediately. Steps that
    // depend on `capturedSend` (the gated host sender) re-assert it
    // inline so a regression surfaces against the right `it`.
    await waitFor(() => {
      expect(mockWebViewState.props).not.toBeNull()
    })
  })

  it('mounts the WebView with the configured baseUrl', () => {
    // `BridgedWebView`'s `useEffect` forks `makeExpoTransport`, sets
    // local `transport` state on success, and only then renders
    // `<TransportWebView>`. The shared `beforeEach` already pinned
    // the mount — the assertion locks in the URL passthrough.
    expect(mockWebViewState.props?.source?.baseUrl).toBe('https://app.test/')
  })

  it("fires each binding's `onTransportReady` with the host-side sender", async () => {
    // `useTransportReadyCaller`'s `useEffect` forks each binding's
    // `onTransportReady` once the transport is non-null; ours
    // captures the host sender.
    await waitFor(() => {
      expect(capturedSend).not.toBeNull()
    })
  })

  it('forwards Host → Page Ping to the WebView only after `__Ready` arrives', async () => {
    await waitFor(() => {
      expect(capturedSend).not.toBeNull()
    })

    // The production wiring previously passed `transport.onMessage`
    // (which returns an Effect) straight into react-native-webview's
    // sync `void` callback; every Effect was constructed and
    // discarded — including `__Ready`. Without that, the host's
    // `peerReady` never resolves and the `sendMessage` below would
    // hang forever.
    const onMessage = mockWebViewState.props?.onMessage
    if (onMessage === undefined) throw new Error('onMessage prop not captured')
    act(() => {
      onMessage({ nativeEvent: { data: '{"_tag":"__Ready"}' } })
    })

    await act(async () => {
      // Narrow inside the closure — TS conservatively widens `let`
      // variables across async-closure boundaries.
      const send = capturedSend
      if (send === null) throw new Error('capturedSend not set')
      await Effect.runPromise(send({ _tag: 'Ping', value: 'hello' }))
    })

    await waitFor(() => {
      expect(mockWebViewState.postMessageCalls).toEqual([
        JSON.stringify({ _tag: 'Ping', value: 'hello' }),
      ])
    })
  })

  it("decodes Page → Host Pong and invokes the binding's receiver layer", async () => {
    await waitFor(() => {
      expect(capturedSend).not.toBeNull()
    })

    const onMessage = mockWebViewState.props?.onMessage
    if (onMessage === undefined) throw new Error('onMessage prop not captured')

    // Page emits __Ready first to mirror the real handshake order
    // (the receiver path doesn't gate on it, but the production flow
    // always sees __Ready before any typed payload).
    act(() => {
      onMessage({ nativeEvent: { data: '{"_tag":"__Ready"}' } })
    })

    act(() => {
      onMessage({
        nativeEvent: { data: JSON.stringify({ _tag: 'Pong', reply: 'world' }) },
      })
    })

    await waitFor(() => {
      expect(pongCalls).toEqual([{ reply: 'world' }])
    })
  })
})

describe('BridgedWebView (initial messages)', () => {
  beforeEach(() => {
    resetMockWebView()
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

    render(
      <BridgedWebView<typeof bindings>
        bindings={bindings}
        BridgeDispatchRegistryProvider={BridgeDispatchRegistryProvider}
        loadFrom={{ _tag: 'html', html: '<!doctype html><html></html>' } as const}
        baseUrl="https://app.test/"
      />
    )

    await waitFor(() => {
      expect(mockWebViewState.props?.source?.baseUrl).toContain('Setup=%2Fwelcome')
    })
  })
})
