/**
 * Pre-mount drop coverage for `BridgedWebView`'s `bareSender` closure.
 *
 * The production closure (in `bridged-webview.tsx`) reads
 * `webviewBareSenderRef.current` on every dispatch; when the ref is
 * still null (the WebView hasn't wired its `useImperativeHandle` yet)
 * it logs a WARN and drops the message. The previous `transport.test.ts`
 * exercised this branch directly because `makeExpoTransport` accepted a
 * ref argument; after the transport build was inlined into
 * `BridgedWebView`, the ref is internal — the only way to reach the
 * branch through the public component API is to keep the WebView
 * mounted but skip the `useImperativeHandle` wiring, leaving the parent
 * ref permanently null. This file does exactly that, then drives a
 * post-`__Ready` send through the binding's captured sender and pins
 * the WARN.
 *
 * A separate file is necessary because every other suite in this
 * package relies on the standard `TransportWebView` mock that DOES
 * wire the ref. Jest mocks live at module scope; a per-test override
 * is too brittle.
 */
import { act, render, waitFor } from '@testing-library/react-native'
import { Effect, Logger, LogLevel, Schema } from 'effect'
import { Bridge, type BridgeTransport, HostBindings } from 'effect-messaging-core'
import {
  mockWebViewModuleFactory,
  mockWebViewState,
  resetMockWebView,
} from './test/mock-webview.ts'

// Pin the WebView mock as in the sibling tests so __Ready and other
// page-side messages still arrive via `onMessage`.
jest.mock('react-native-webview', () => mockWebViewModuleFactory())

jest.mock('expo-web-browser', () => ({
  openBrowserAsync: jest.fn(() => Promise.resolve()),
}))

// Replace `TransportWebView` with a no-imperative-handle stand-in: it
// still forwards `onMessage` so __Ready can route through, but the
// `useImperativeHandle` on the parent ref never fires — leaving
// `BridgedWebView`'s `webviewBareSenderRef.current` null for the
// lifetime of the component. Babel-plugin-jest-hoist forbids
// out-of-scope references inside the factory; props are typed
// inline as `unknown` to keep the factory hoist-safe.
jest.mock('./transport-webview.tsx', () => ({
  TransportWebView: function MockTransportWebView(props: {
    readonly source?: { readonly html?: string; readonly baseUrl?: string; readonly uri?: string }
    readonly onMessage?: (event: { readonly nativeEvent: { readonly data: string } }) => void
  }): null {
    mockWebViewState.props = props
    return null
  },
}))

import { BridgedWebView } from './bridged-webview.tsx'

const PingSchema = Schema.parseJson(Schema.TaggedStruct('Ping', { value: Schema.String }))
const PongSchema = Schema.parseJson(Schema.TaggedStruct('Pong', { reply: Schema.String }))

const PingPongBridge = Bridge.make({
  name: 'PingPong',
  hostToWeb: [['Ping', PingSchema]] as const,
  webToHost: [['Pong', PongSchema]] as const,
})

type PingPongSend = BridgeTransport.MessageSender<readonly [typeof PingPongBridge], 'Host'>

interface CapturedLog {
  readonly level: LogLevel.LogLevel['label']
  readonly message: unknown
}

/** Replace the default logger with one that pushes into `sink`. */
const captureLogs = (sink: CapturedLog[]): ReturnType<typeof Logger.replace> =>
  Logger.replace(
    Logger.defaultLogger,
    Logger.make(({ logLevel, message }) => {
      sink.push({ level: logLevel.label, message })
    })
  )

describe('BridgedWebView (pre-mount drop)', () => {
  beforeEach(() => {
    resetMockWebView()
  })

  it("warns 'no WebView handle yet' and drops when the captured sender fires before the WebView ref is wired", async () => {
    const sink: CapturedLog[] = []
    let capturedSend: PingPongSend | null = null

    const bindings = HostBindings.single({
      bridge: PingPongBridge,
      receiverLayer: PingPongBridge.Host.ReceiverLayer({ Pong: () => Effect.void }),
      onTransportReady: (send) =>
        // Route the send under the capturing logger so the WARN the
        // production bareSender emits lands in `sink`.
        Effect.sync(() => {
          capturedSend = send
        }).pipe(Effect.provide(captureLogs(sink)), Logger.withMinimumLogLevel(LogLevel.All)),
    })

    render(
      <BridgedWebView
        bindings={bindings}
        loadFrom={{
          _tag: 'html',
          html: '<!doctype html><html></html>',
          baseUrl: 'https://app.test/',
        }}
      />
    )

    await waitFor(() => {
      expect(mockWebViewState.props).not.toBeNull()
    })

    // Page-side __Ready releases the host's `peerReady` gate so the
    // queued send actually advances to the bareSender — without it the
    // send would suspend forever and the WARN never fires.
    const onMessage = mockWebViewState.props?.onMessage
    if (onMessage === undefined) throw new Error('onMessage prop not captured')
    act(() => {
      onMessage({ nativeEvent: { data: '{"_tag":"__Ready"}' } })
    })

    await waitFor(() => {
      expect(capturedSend).not.toBeNull()
    })

    // Fire the send under the same capturing logger; the bareSender's
    // null-ref branch emits one WARN and returns undefined.
    await act(async () => {
      const send = capturedSend
      if (send === null) throw new Error('capturedSend not set')
      await Effect.runPromise(
        send({ _tag: 'Ping', value: 'should-drop' }).pipe(
          Effect.provide(captureLogs(sink)),
          Logger.withMinimumLogLevel(LogLevel.All)
        )
      )
    })

    // The WARN substring is intentional — pins the user-visible advice
    // without brittling on the surrounding fiber/timestamp framing.
    const warned = sink.find(
      (entry) =>
        entry.level === 'WARN' && JSON.stringify(entry.message).includes('no WebView handle yet')
    )
    expect(warned).toBeDefined()

    // The send must not throw — the production contract is drop-and-warn,
    // not raise. `postMessageCalls` stays empty since the ref-wired
    // dispatch path never ran.
    expect(mockWebViewState.postMessageCalls).toEqual([])
  })
})
