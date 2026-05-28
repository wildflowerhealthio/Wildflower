import { render } from '@testing-library/react-native'
import { BrowserSnifferBridge } from 'browser-sniffer-core/bridge'
import { snifferScript } from 'browser-sniffer-injected'
import { Effect, LogLevel, Logger } from 'effect'
import type { Bridge, Logging } from 'effect-messaging-core'
import type { BridgedWebViewLoadFrom, BridgedWebViewProps } from 'effect-messaging-expo'
import * as React from 'react'

type MockBridgedWebViewProps = BridgedWebViewProps<ReadonlyArray<Bridge.AnyBridge>>

const mockBridgedWebViewState: {
  lastProps: MockBridgedWebViewProps | null
} = {
  lastProps: null,
}

/**
 * Side-channel capture of every `useLogHostBinding` call the wrapper
 * makes. Lets the assertion compare the consumer's `onLog` against
 * what got threaded through the hook without inspecting the merged
 * `bindings` value (which `BridgedWebView`'s mock receives as
 * `HostBindings<ReadonlyArray<Bridge.AnyBridge>>`, a structurally
 * widened shape that doesn't carry our mock fields).
 */
const mockUseLogHostBindingCalls: Array<{
  onLog?: (log: Logging.LogPayload) => Effect.Effect<void>
}> = []

/**
 * Minimal stand-in returned by the mocked `useLogHostBinding`. Shape
 * matches the four parallel arrays {@link HostBindings.combine}
 * concatenates, so the wrapper's `HostBindings.combine(...)` succeeds
 * at runtime without pulling in the real bridge plumbing.
 */
const MOCK_LOG_BINDINGS = {
  bridges: [{ name: 'MockLog' }],
  receiverLayers: [{ _tag: 'mock-log-receiver-layer' }],
  initialMessages: [[]],
  onTransportReady: [undefined],
} as const

jest.mock('effect-messaging-expo', () => {
  const ReactInner = jest.requireActual<typeof React>('react')
  return {
    BridgedWebView: (props: MockBridgedWebViewProps): React.ReactElement | null => {
      mockBridgedWebViewState.lastProps = props
      return ReactInner.createElement('MockBridgedWebView', null)
    },
    useLogHostBinding: (opts: {
      onLog?: (log: Logging.LogPayload) => Effect.Effect<void>
    }): typeof MOCK_LOG_BINDINGS => {
      mockUseLogHostBindingCalls.push(opts)
      return MOCK_LOG_BINDINGS
    },
  }
})

// `import` after the `jest.mock` factory so the wrapper picks up the
// stub. (Hoist makes the `jest.mock` run before this import, but
// keeping the import below the factory makes the order obvious to
// readers.)
import {
  BrowserSnifferWebView,
  type BrowserSnifferMessageSender,
} from './BrowserSnifferWebView.tsx'

// Identity-stable handler tables so the test doesn't accidentally
// rebuild the transport between renders. Empty receivers — the
// component's only job in these tests is to wire its inputs into
// `BridgedWebView`, not actually decode anything.
const SNIFFER_HANDLERS = {
  Cancelled: () => Effect.void,
  PageLoaded: () => Effect.void,
  RequestError: () => Effect.void,
  ResponseData: () => Effect.void,
  ResponseFinished: () => Effect.void,
  ResponseStart: () => Effect.void,
} as const

beforeEach(() => {
  mockBridgedWebViewState.lastProps = null
  mockUseLogHostBindingCalls.length = 0
})

describe('BrowserSnifferWebView (wrapper around BridgedWebView)', () => {
  it('wires the sniffer binding alongside the log binding from useLogHostBinding', () => {
    render(
      <BrowserSnifferWebView
        loadFrom={{ _tag: 'uri', uri: 'https://patient.example.com/' }}
        browserSnifferHandlers={SNIFFER_HANDLERS}
      />
    )
    const props = mockBridgedWebViewState.lastProps
    if (props === null) throw new Error('BridgedWebView never mounted')

    const snifferIndex = props.bindings.bridges.findIndex(
      (b) => b.name === BrowserSnifferBridge.name
    )
    if (snifferIndex < 0) throw new Error('sniffer binding missing')
    expect(props.bindings.bridges[snifferIndex]).toBe(BrowserSnifferBridge)

    // Side-channel confirms `useLogHostBinding` was invoked — proves
    // the wrapper went through the canonical hook rather than
    // inlining the binding construction.
    expect(mockUseLogHostBindingCalls.length).toBe(1)
  })

  it('passes the sniffer script to BridgedWebView', () => {
    render(
      <BrowserSnifferWebView
        loadFrom={{ _tag: 'uri', uri: 'https://patient.example.com/' }}
        browserSnifferHandlers={SNIFFER_HANDLERS}
      />
    )
    const props = mockBridgedWebViewState.lastProps
    if (props === null) throw new Error('BridgedWebView never mounted')
    expect(props.injectedJavaScriptBeforeContentLoaded).toBe(snifferScript)
    // Sniffer relies on TransportWebView's "always in-WebView" default
    // (no `shouldOpenInSystemBrowser` predicate is supplied) so FHIR
    // OAuth cross-origin redirects stay in the WebView.
    expect(props.shouldOpenInSystemBrowser).toBeUndefined()
  })

  it('passes a uri loadFrom through unchanged', () => {
    const loadFrom: BridgedWebViewLoadFrom = {
      _tag: 'uri',
      uri: 'https://patient.example.com/',
    }
    render(<BrowserSnifferWebView loadFrom={loadFrom} browserSnifferHandlers={SNIFFER_HANDLERS} />)
    const props = mockBridgedWebViewState.lastProps
    if (props === null) throw new Error('BridgedWebView never mounted')
    expect(props.loadFrom).toEqual(loadFrom)
  })

  it('embeds the sniffer script after <head> for an html loadFrom', () => {
    render(
      <BrowserSnifferWebView
        loadFrom={{
          _tag: 'html',
          html: '<!doctype html><html><head><title>x</title></head><body></body></html>',
          baseUrl: 'https://patient.example.com/',
        }}
        browserSnifferHandlers={SNIFFER_HANDLERS}
      />
    )
    const props = mockBridgedWebViewState.lastProps
    if (props === null) throw new Error('BridgedWebView never mounted')
    if (props.loadFrom._tag !== 'html') throw new Error('expected html loadFrom')
    // The script tag lands immediately after `<head>` so it runs
    // before any other script in the document.
    expect(props.loadFrom.html).toBe(
      `<!doctype html><html><head><script>${snifferScript}</script><title>x</title></head><body></body></html>`
    )
    // baseUrl flows through unchanged — only the html string is
    // rewritten.
    expect(props.loadFrom.baseUrl).toBe('https://patient.example.com/')
  })

  it('prepends the sniffer script when the html has no <head>', () => {
    render(
      <BrowserSnifferWebView
        loadFrom={{ _tag: 'html', html: '<body>no head</body>', baseUrl: 'https://x/' }}
        browserSnifferHandlers={SNIFFER_HANDLERS}
      />
    )
    const props = mockBridgedWebViewState.lastProps
    if (props === null) throw new Error('BridgedWebView never mounted')
    if (props.loadFrom._tag !== 'html') throw new Error('expected html loadFrom')
    expect(props.loadFrom.html).toBe(`<script>${snifferScript}</script><body>no head</body>`)
  })
})

describe('BrowserSnifferWebView ref-exposed MessageSender', () => {
  it('drops pre-mount messages and logs an error', async () => {
    const ref = React.createRef<BrowserSnifferMessageSender>()
    render(
      <BrowserSnifferWebView
        ref={ref}
        loadFrom={{ _tag: 'uri', uri: 'https://x/' }}
        browserSnifferHandlers={SNIFFER_HANDLERS}
      />
    )
    // BridgedWebView is mocked — `onTransportReady` never fires, so
    // `senderRef.current` stays null. Collect the captured log via a
    // custom logger so we can assert the error landed without
    // polluting stdout.
    const logs: string[] = []
    const captureLogger = Logger.make(({ message }) => {
      logs.push(typeof message === 'string' ? message : JSON.stringify(message))
    })
    if (ref.current === null) throw new Error('ref never populated')
    await Effect.runPromise(
      ref
        .current({ _tag: 'Click', querySelector: '#go' })
        .pipe(
          Effect.provide(Logger.replace(Logger.defaultLogger, captureLogger)),
          Logger.withMinimumLogLevel(LogLevel.All)
        )
    )
    expect(logs.some((m) => m.includes('[browser-sniffer-expo] dropped pre-mount message'))).toBe(
      true
    )
  })

  it('delegates to the binding-captured sender once onTransportReady fires', async () => {
    const ref = React.createRef<BrowserSnifferMessageSender>()
    render(
      <BrowserSnifferWebView
        ref={ref}
        loadFrom={{ _tag: 'uri', uri: 'https://x/' }}
        browserSnifferHandlers={SNIFFER_HANDLERS}
      />
    )
    const props = mockBridgedWebViewState.lastProps
    if (props === null) throw new Error('BridgedWebView never mounted')
    const snifferIndex = props.bindings.bridges.findIndex(
      (b) => b.name === BrowserSnifferBridge.name
    )
    if (snifferIndex < 0) throw new Error('sniffer binding missing')
    const onTransportReady = props.bindings.onTransportReady[snifferIndex]
    if (onTransportReady === undefined) throw new Error('sniffer onTransportReady missing')

    // Stand in for the per-binding sender the transport would supply
    // via `HostBindings.callTransportReady`. Captures every message
    // the wrapper forwards.
    const sends: Array<{ readonly _tag: string }> = []
    const fakeSend = (msg: { readonly _tag: string }): Effect.Effect<void> =>
      Effect.sync(() => {
        sends.push(msg)
      })

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    await Effect.runPromise(onTransportReady(fakeSend as never))

    if (ref.current === null) throw new Error('ref never populated')
    await Effect.runPromise(ref.current({ _tag: 'Click', querySelector: 'button.import' }))
    expect(sends).toEqual([{ _tag: 'Click', querySelector: 'button.import' }])
  })

  it('threads onLog through to useLogHostBinding verbatim', async () => {
    const logCalls: Array<Logging.LogPayload> = []
    const myOnLog = (msg: Logging.LogPayload): Effect.Effect<void> =>
      Effect.sync(() => {
        logCalls.push(msg)
      })
    render(
      <BrowserSnifferWebView
        loadFrom={{ _tag: 'uri', uri: 'https://x/' }}
        onLog={myOnLog}
        browserSnifferHandlers={SNIFFER_HANDLERS}
      />
    )
    expect(mockUseLogHostBindingCalls.length).toBe(1)
    // Reference equality — the wrapper must pass through the supplied
    // function without wrapping it, so the hook's `defaultOnLog`
    // override semantics still work as documented.
    expect(mockUseLogHostBindingCalls[0]?.onLog).toBe(myOnLog)
    // Sanity: the captured function is the one we passed.
    const captured = mockUseLogHostBindingCalls[0]?.onLog
    if (captured === undefined) throw new Error('onLog not captured')
    await Effect.runPromise(captured({ _tag: 'Log', level: 'info', payload: ['hi'] }))
    expect(logCalls).toEqual([{ _tag: 'Log', level: 'info', payload: ['hi'] }])
  })

  it('forwards undefined onLog when omitted so the hook default kicks in', () => {
    render(
      <BrowserSnifferWebView
        loadFrom={{ _tag: 'uri', uri: 'https://x/' }}
        browserSnifferHandlers={SNIFFER_HANDLERS}
      />
    )
    expect(mockUseLogHostBindingCalls.length).toBe(1)
    // `useLogHostBinding` itself defaults `onLog` to
    // `Logging.defaultOnLog` via parameter destructuring; passing
    // `undefined` here lets that default activate.
    expect(mockUseLogHostBindingCalls[0]?.onLog).toBeUndefined()
  })
})

// End-to-end coverage (real `BridgedWebView`, mocked WebView) lives
// in `BrowserSnifferWebView.e2e.test.tsx`. Keeping it in a separate
// file because the global `jest.mock('effect-messaging-expo')` above
// is file-wide-hoisted and can't be bypassed inside the same file
// without --experimental-vm-modules.
