import { act, render, waitFor } from '@testing-library/react-native'
import { Effect, Schema } from 'effect'
import { Bridge, type BridgeTransport, HostBindings } from 'effect-messaging-core'
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

type PingPongSend = BridgeTransport.MessageSender<readonly [typeof PingPongBridge], 'Host'>

describe('BridgedWebView (integration)', () => {
  // Per-test captures populated by `beforeEach`. The shared setup
  // builds the bindings (with `pongCalls` + `capturedSend` captures)
  // and renders the host shell. Each `it()` block exercises one
  // slice of the handshake / round-trip sequence against this baseline.
  let pongCalls: Array<{ readonly reply: string }>
  let capturedSend: PingPongSend | null

  beforeEach(async () => {
    resetMockWebView()
    pongCalls = []
    capturedSend = null

    const bindings = HostBindings.single({
      bridge: PingPongBridge,
      handlers: {
        Pong: ({ reply }) => Effect.sync(() => pongCalls.push({ reply })),
      },
      onTransportReady: (send) =>
        Effect.sync(() => {
          capturedSend = send
        }),
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

    // Wait for the WebView to mount so individual tests can grab
    // `mockWebViewState.props?.onMessage` immediately. Steps that
    // depend on `capturedSend` (the gated host sender) re-assert it
    // inline so a regression surfaces against the right `it`.
    await waitFor(() => {
      expect(mockWebViewState.props).not.toBeNull()
    })
  })

  it('mounts the WebView with the configured baseUrl', () => {
    // `BridgedWebView`'s `useEffect` forks the inlined transport build,
    // sets local `transport` state on success, and only then renders
    // `<TransportWebView>`. The shared `beforeEach` already pinned
    // the mount — the assertion locks in the URL passthrough.
    expect(mockWebViewState.props?.source?.baseUrl).toBe('https://app.test/')
  })

  it("fires each binding's `onTransportReady` with the host-side sender", async () => {
    // `BridgedWebView`'s `useEffect` (transport-ready branch) forks
    // each binding's `onTransportReady` once the transport is
    // non-null; ours captures the host sender.
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

  it("decodes Page → Host Pong and invokes the binding's handler record", async () => {
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

    const bindings = HostBindings.single({
      bridge: BootBridge,
      handlers: {},
      initialMessages: [{ _tag: 'Setup', path: '/welcome' }],
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
      expect(mockWebViewState.props?.source?.baseUrl).toContain('Setup=%2Fwelcome')
    })
  })

  it("encodes a binding's `initialMessages` into the WebView URI when `loadFrom._tag === 'uri'`", async () => {
    // Mirror of the html case but for the `uri` source variant: the
    // params land on the URI the WebView loads directly, not as a
    // baseUrl alongside inline html.
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

    const bindings = HostBindings.single({
      bridge: BootBridge,
      handlers: {},
      initialMessages: [{ _tag: 'Setup', path: '/welcome' }],
    })

    render(
      <BridgedWebView bindings={bindings} loadFrom={{ _tag: 'uri', uri: 'https://app.test/' }} />
    )

    await waitFor(() => {
      expect(mockWebViewState.props?.source?.uri).toContain('Setup=%2Fwelcome')
    })
  })

  it('preserves an existing query string verbatim when initialMessages is omitted (no extra params, no trailing ?)', async () => {
    // Sentinel coverage for the empty-initialMessages-with-existing-query
    // path: a regression that appended a stray separator (or always
    // emitted a `?` even when there's nothing to add) would slip through
    // the other tests in this block, all of which exercise non-empty
    // initialMessages.
    const NoopBridge = Bridge.make({
      name: 'Noop',
      hostToWeb: [] as const,
      webToHost: [] as const,
    })

    const bindings = HostBindings.single({
      bridge: NoopBridge,
      handlers: {},
      // initialMessages intentionally omitted — defaults to [[]].
    })

    render(
      <BridgedWebView
        bindings={bindings}
        loadFrom={{ _tag: 'uri', uri: 'https://app.test/?keep=me' }}
      />
    )

    await waitFor(() => {
      expect(mockWebViewState.props?.source?.uri).toBe('https://app.test/?keep=me')
    })
  })

  it('merges initialMessages alongside an existing query string on loadFrom.uri', async () => {
    // Pins the merge-vs-replace contract called out in the loadFrom
    // TSDoc: an existing query string on `loadFrom.uri` is preserved
    // alongside the binding's encoded initial messages, not replaced.
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

    const bindings = HostBindings.single({
      bridge: BootBridge,
      handlers: {},
      initialMessages: [{ _tag: 'Setup', path: '/welcome' }],
    })

    render(
      <BridgedWebView
        bindings={bindings}
        loadFrom={{ _tag: 'uri', uri: 'https://app.test/?session=abc' }}
      />
    )

    await waitFor(() => {
      const uri = mockWebViewState.props?.source?.uri
      if (uri === undefined) throw new Error('WebView source uri not captured')
      const params = new URL(uri).searchParams
      expect(params.get('session')).toBe('abc')
      expect(params.get('Setup')).toBe('/welcome')
    })
  })
})

// ---------------------------------------------------------------------------
// Multi-binding combine: two distinct fixture bridges wired together.
// The whole point of the parallel-array refactor is that each binding's
// sender is constrained to its own tags and page-side messages decode
// against the correct handler record. The single-bridge cases above
// collapse the alignment question — these tests guard against
// regressions that mis-align the per-binding arrays.
// ---------------------------------------------------------------------------

const FooSchema = Schema.parseJson(Schema.TaggedStruct('Foo', { value: Schema.String }))
const FooReplySchema = Schema.parseJson(Schema.TaggedStruct('FooReply', { reply: Schema.String }))
const BarSchema = Schema.parseJson(Schema.TaggedStruct('Bar', { value: Schema.Number }))
const BarReplySchema = Schema.parseJson(Schema.TaggedStruct('BarReply', { count: Schema.Number }))

const FooBarBridge = Bridge.make({
  name: 'FooBar',
  hostToWeb: [['Foo', FooSchema]] as const,
  webToHost: [['FooReply', FooReplySchema]] as const,
})
const BazBridge = Bridge.make({
  name: 'Baz',
  hostToWeb: [['Bar', BarSchema]] as const,
  webToHost: [['BarReply', BarReplySchema]] as const,
})

type FooSend = BridgeTransport.MessageSender<readonly [typeof FooBarBridge], 'Host'>
type BarSend = BridgeTransport.MessageSender<readonly [typeof BazBridge], 'Host'>

describe('BridgedWebView (multi-binding combine)', () => {
  beforeEach(() => {
    resetMockWebView()
  })

  it('fires each binding onTransportReady with its own narrowly-typed sender, and routes each page message to the correct handler record', async () => {
    const fooReplies: Array<{ reply: string }> = []
    const barReplies: Array<{ count: number }> = []
    let fooSend: FooSend | null = null
    let barSend: BarSend | null = null

    const fooBindings = HostBindings.single({
      bridge: FooBarBridge,
      handlers: {
        FooReply: ({ reply }) => Effect.sync(() => fooReplies.push({ reply })),
      },
      onTransportReady: (send) =>
        Effect.sync(() => {
          fooSend = send
        }),
    })

    const barBindings = HostBindings.single({
      bridge: BazBridge,
      handlers: {
        BarReply: ({ count }) => Effect.sync(() => barReplies.push({ count })),
      },
      onTransportReady: (send) =>
        Effect.sync(() => {
          barSend = send
        }),
    })

    const merged = HostBindings.combine([fooBindings, barBindings])

    render(
      <BridgedWebView
        bindings={merged}
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

    // Both senders were captured — `onTransportReady` fired for both
    // slots, not just one.
    await waitFor(() => {
      expect(fooSend).not.toBeNull()
      expect(barSend).not.toBeNull()
    })

    // Deliver `__Ready` so the gated dispatch fiber unblocks.
    const onMessage = mockWebViewState.props?.onMessage
    if (onMessage === undefined) throw new Error('onMessage prop not captured')
    act(() => {
      onMessage({ nativeEvent: { data: '{"_tag":"__Ready"}' } })
    })

    // Each per-binding sender, narrowly typed to its own bridge, routes
    // through the same transport and ends up on the WebView postMessage
    // log in order.
    await act(async () => {
      const fs = fooSend
      const bs = barSend
      if (fs === null || bs === null) throw new Error('sender capture missing')
      await Effect.runPromise(fs({ _tag: 'Foo', value: 'hello' }))
      await Effect.runPromise(bs({ _tag: 'Bar', value: 7 }))
    })

    await waitFor(() => {
      expect(mockWebViewState.postMessageCalls).toEqual([
        JSON.stringify({ _tag: 'Foo', value: 'hello' }),
        JSON.stringify({ _tag: 'Bar', value: 7 }),
      ])
    })

    // Page-side replies decode to the matching handler record — Foo to
    // Foo's handler, Bar to Bar's. A regression that swapped handler
    // records across the parallel arrays would land replies in the
    // wrong sink.
    act(() => {
      onMessage({
        nativeEvent: { data: JSON.stringify({ _tag: 'FooReply', reply: 'pong-foo' }) },
      })
      onMessage({
        nativeEvent: { data: JSON.stringify({ _tag: 'BarReply', count: 42 }) },
      })
    })

    await waitFor(() => {
      expect(fooReplies).toEqual([{ reply: 'pong-foo' }])
      expect(barReplies).toEqual([{ count: 42 }])
    })
  })
})

// The `registerHandlers` semantics (handler-record swap, FIFO ordering
// against in-flight inbound, no resource leaks) are exercised at the
// core level in `bridge-transport.test.ts`, where the inbox barrier
// provides a deterministic await. The BridgedWebView wiring of
// `registerHandlers` into a useEffect is small enough that the existing
// "decodes Page → Host Pong" test above pins the happy path.
