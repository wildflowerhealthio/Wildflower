import { render } from '@testing-library/react-native'
import BrowserSnifferBridge from 'browser-sniffer-core/bridge'
import { snifferScript } from 'browser-sniffer-injected'
import { Effect, LogLevel, Logger } from 'effect'
import type { HostBinding, LogBridge } from 'effect-messaging-core'
import type { BridgedWebViewLoadFrom, BridgedWebViewProps } from 'effect-messaging-expo'
import React from 'react'

/**
 * `mockBridgedWebViewState` collects the props each render of the
 * stubbed `BridgedWebView` was called with. `useLogHostBinding`'s
 * mock returns a sentinel object so the test can spot it inside the
 * bindings tuple. `mock`-prefix everywhere so jest's hoist accepts
 * the references inside the factory below.
 */
type MockBridgedWebViewProps = BridgedWebViewProps<ReadonlyArray<HostBinding.Any>>

const mockBridgedWebViewState: {
  lastProps: MockBridgedWebViewProps | null
} = {
  lastProps: null,
}

const mockLogBindingMarker = Symbol.for(
  'browser-sniffer-expo:BrowserSnifferWebView.test:logBindingMarker'
)

/** Shape `useLogHostBinding` returns under the mock. */
interface MockLogBinding {
  readonly mockLogBindingMarker: typeof mockLogBindingMarker
  readonly onLog?: (log: LogBridge.LogPayload) => Effect.Effect<void>
}

/** Type guard so the test can interrogate a binding without unsafe casts. */
const isMockLogBinding = (value: unknown): value is MockLogBinding =>
  typeof value === 'object' && value !== null && 'mockLogBindingMarker' in value

const mockResetBridgedWebView = (): void => {
  mockBridgedWebViewState.lastProps = null
}

jest.mock('effect-messaging-expo', () => {
  const ReactInner = jest.requireActual<typeof React>('react')
  return {
    BridgedWebView: <TBindings extends ReadonlyArray<HostBinding.Any>>(
      props: BridgedWebViewProps<TBindings>
    ): React.ReactElement | null => {
      // Widen the captured generic to the widest shape so a single
      // `lastProps` field types across renders. Runtime payload is
      // the same — type-only widening, but the rule still flags it.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      mockBridgedWebViewState.lastProps = props as unknown as MockBridgedWebViewProps
      return ReactInner.createElement('MockBridgedWebView', null)
    },
    useLogHostBinding: ({
      onLog,
    }: {
      onLog?: (log: LogBridge.LogPayload) => Effect.Effect<void>
    }): MockLogBinding => ({
      mockLogBindingMarker,
      onLog,
    }),
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

const LOG_HANDLERS = { Log: () => Effect.void } as const

describe('BrowserSnifferWebView (wrapper around BridgedWebView)', () => {
  beforeEach(() => {
    mockResetBridgedWebView()
  })

  it('mounts BridgedWebView with the sniffer binding first and the log binding second', () => {
    render(
      <BrowserSnifferWebView
        loadFrom={{ _tag: 'uri', uri: 'https://patient.example.com/' }}
        logHandler={LOG_HANDLERS}
        browserSnifferHandler={SNIFFER_HANDLERS}
      />
    )
    const props = mockBridgedWebViewState.lastProps
    if (props === null) throw new Error('BridgedWebView never mounted')
    expect(props.bindings).toHaveLength(2)
    const [snifferBinding, logBinding] = props.bindings
    expect(snifferBinding?.bridge).toBe(BrowserSnifferBridge)
    // Sentinel from the `useLogHostBinding` mock — confirms the
    // wrapper went through the canonical hook rather than building
    // the binding inline.
    expect(isMockLogBinding(logBinding)).toBe(true)
  })

  it('passes the sniffer script and a cross-origin-permissive routing gate to BridgedWebView', () => {
    render(
      <BrowserSnifferWebView
        loadFrom={{ _tag: 'uri', uri: 'https://patient.example.com/' }}
        logHandler={LOG_HANDLERS}
        browserSnifferHandler={SNIFFER_HANDLERS}
      />
    )
    const props = mockBridgedWebViewState.lastProps
    if (props === null) throw new Error('BridgedWebView never mounted')
    expect(props.injectedJavaScriptBeforeContentLoaded).toBe(snifferScript)
    // The wrapper forces every navigation in-WebView so FHIR OAuth
    // cross-origin redirects don't get shunted to the system browser.
    expect(props.shouldHandleInWebView).toBeDefined()
    expect(props.shouldHandleInWebView?.('https://elsewhere.example.com/oauth')).toBe(true)
  })

  it('passes a uri loadFrom through unchanged', () => {
    const loadFrom: BridgedWebViewLoadFrom = {
      _tag: 'uri',
      uri: 'https://patient.example.com/',
    }
    render(
      <BrowserSnifferWebView
        loadFrom={loadFrom}
        logHandler={LOG_HANDLERS}
        browserSnifferHandler={SNIFFER_HANDLERS}
      />
    )
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
        logHandler={LOG_HANDLERS}
        browserSnifferHandler={SNIFFER_HANDLERS}
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
        logHandler={LOG_HANDLERS}
        browserSnifferHandler={SNIFFER_HANDLERS}
      />
    )
    const props = mockBridgedWebViewState.lastProps
    if (props === null) throw new Error('BridgedWebView never mounted')
    if (props.loadFrom._tag !== 'html') throw new Error('expected html loadFrom')
    expect(props.loadFrom.html).toBe(`<script>${snifferScript}</script><body>no head</body>`)
  })
})

describe('BrowserSnifferWebView ref-exposed MessageSender', () => {
  beforeEach(() => {
    mockResetBridgedWebView()
  })

  it('drops pre-mount messages and logs an error', async () => {
    const ref = React.createRef<BrowserSnifferMessageSender>()
    render(
      <BrowserSnifferWebView
        ref={ref}
        loadFrom={{ _tag: 'uri', uri: 'https://x/' }}
        logHandler={LOG_HANDLERS}
        browserSnifferHandler={SNIFFER_HANDLERS}
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
    expect(logs.some((m) => m.includes('dropped pre-mount message Click'))).toBe(true)
  })

  it('delegates to the binding-captured sender once onTransportReady fires', async () => {
    const ref = React.createRef<BrowserSnifferMessageSender>()
    render(
      <BrowserSnifferWebView
        ref={ref}
        loadFrom={{ _tag: 'uri', uri: 'https://x/' }}
        logHandler={LOG_HANDLERS}
        browserSnifferHandler={SNIFFER_HANDLERS}
      />
    )
    const props = mockBridgedWebViewState.lastProps
    if (props === null) throw new Error('BridgedWebView never mounted')
    const snifferBinding = props.bindings[0]
    if (snifferBinding === undefined) throw new Error('sniffer binding missing')

    // Stand in for the per-binding sender the transport would supply
    // via `HostBinding.callTransportReady`. Captures every message
    // the wrapper forwards.
    const sends: Array<{ readonly _tag: string }> = []
    const fakeSend = (msg: { readonly _tag: string }): Effect.Effect<void> =>
      Effect.sync(() => {
        sends.push(msg)
      })

    if (snifferBinding.onTransportReady === undefined)
      throw new Error('snifferBinding.onTransportReady missing')
    await Effect.runPromise(snifferBinding.onTransportReady(fakeSend))

    if (ref.current === null) throw new Error('ref never populated')
    await Effect.runPromise(ref.current({ _tag: 'Click', querySelector: 'button.import' }))
    expect(sends).toEqual([{ _tag: 'Click', querySelector: 'button.import' }])
  })

  it('routes logHandler.Log into the log binding via useLogHostBinding', async () => {
    const logCalls: Array<LogBridge.LogPayload> = []
    const myLogHandler = {
      Log: (msg: LogBridge.LogPayload): Effect.Effect<void> =>
        Effect.sync(() => {
          logCalls.push(msg)
        }),
    } as const
    render(
      <BrowserSnifferWebView
        loadFrom={{ _tag: 'uri', uri: 'https://x/' }}
        logHandler={myLogHandler}
        browserSnifferHandler={SNIFFER_HANDLERS}
      />
    )
    const props = mockBridgedWebViewState.lastProps
    if (props === null) throw new Error('BridgedWebView never mounted')
    const logBinding = props.bindings[1]
    if (!isMockLogBinding(logBinding)) throw new Error('expected log binding sentinel at index 1')
    if (logBinding.onLog === undefined) throw new Error('log binding did not capture onLog')
    // Mock `useLogHostBinding` captured the `onLog` arg — invoke it
    // directly to confirm the wrapper threaded the consumer's
    // `logHandler.Log` through to the hook.
    await Effect.runPromise(logBinding.onLog({ _tag: 'Log', level: 'info', payload: ['hi'] }))
    expect(logCalls).toEqual([{ _tag: 'Log', level: 'info', payload: ['hi'] }])
  })
})
