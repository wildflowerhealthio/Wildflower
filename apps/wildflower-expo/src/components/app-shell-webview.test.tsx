import { act, render } from '@testing-library/react-native'
import type { Effect as EffectType, Layer as LayerType } from 'effect'
import * as React from 'react'
import type { ReactElement } from 'react'

// Hoisted module-scoped captures the mocked `effect-messaging-expo`
// populates on each render — `mock` prefix is required for
// babel-plugin-jest-hoist to leave them alone.
let mockLastUseTransportConfig: {
  readonly initialMessages: ReadonlyArray<unknown>
  readonly baseUrl?: string
} | null = null

let mockSendMessageCalls: Array<{ readonly _tag: string; readonly token?: string }> = []

let mockLastTransport: {
  readonly embedUrl: string
  readonly onMessage: (event: unknown) => void
  readonly sendMessage: (msg: { _tag: string; token?: string }) => EffectType.Effect<void>
} | null = null

jest.mock('effect-messaging-expo', () => {
  const ReactInner = jest.requireActual<typeof React>('react')
  const effect = jest.requireActual<{ Effect: typeof EffectType }>('effect')
  const buildTransport = (config: {
    readonly initialMessages: ReadonlyArray<unknown>
    readonly baseUrl: string
  }): {
    readonly embedUrl: string
    readonly onMessage: (event: unknown) => void
    readonly sendMessage: (msg: { _tag: string; token?: string }) => EffectType.Effect<void>
  } => {
    mockLastUseTransportConfig = config
    const transport = {
      sendMessage: (msg: { _tag: string; token?: string }): EffectType.Effect<void> =>
        effect.Effect.sync(() => {
          mockSendMessageCalls.push(msg)
        }),
      embedUrl: `${config.baseUrl}?msg.MOCK=stub`,
      onMessage: (): void => undefined,
    }
    mockLastTransport = transport
    return transport
  }
  return {
    EffectMessagingWebView: ReactInner.forwardRef(function MockEffectMessagingWebView(
      props: { readonly source?: { readonly html?: string; readonly baseUrl?: string } },
      _ref: unknown
    ): ReactElement {
      return ReactInner.createElement('EffectMessagingWebView', props)
    }),
    useTransport: buildTransport,
    // The production file uses `<WithTransport>` (render-prop wrapper
    // around `useTransport`), not `useTransport` directly. The mock
    // mirrors that shape so the test exercises the real call site.
    WithTransport: function MockWithTransport(props: {
      readonly initialMessages: ReadonlyArray<unknown>
      readonly baseUrl: string
      readonly children: (transport: ReturnType<typeof buildTransport>) => ReactElement | null
    }): ReactElement | null {
      const transport = buildTransport({
        initialMessages: props.initialMessages,
        baseUrl: props.baseUrl,
      })
      return props.children(transport)
    },
  }
})

// Stub workspace bridge modules so the receiver-layer composition is
// satisfied without actually building real bridges.
const makeBridgeStub = (): { Host: { ReceiverLayer: (h: unknown) => LayerType.Layer<never> } } => {
  const effect = jest.requireActual<{ Effect: typeof EffectType; Layer: typeof LayerType }>(
    'effect'
  )
  return {
    Host: {
      ReceiverLayer: (_handlers: unknown): LayerType.Layer<never> =>
        effect.Layer.effectDiscard(effect.Effect.void),
    },
  }
}

jest.mock('navigation-core', () => ({ NavigationBridge: makeBridgeStub() }))
jest.mock('gatekeeper-core/bridge', () => ({ __esModule: true, default: makeBridgeStub() }))
jest.mock('collector-fundamentals/bridge', () => ({ __esModule: true, default: makeBridgeStub() }))
jest.mock('apps-core/bridge', () => ({ __esModule: true, default: makeBridgeStub() }))

jest.mock('wildflower-react/embeddable-html', () => ({ html: '<!doctype html><html></html>' }))

jest.mock('expo-tundraish', () => ({
  useColorScheme: (): 'light' => 'light',
  Colors: {
    light: { background: '#fff', icon: '#000' },
    dark: { background: '#000', icon: '#fff' },
  },
}))

import { AppShellWebView } from './app-shell-webview.tsx'

beforeEach(() => {
  mockLastUseTransportConfig = null
  mockSendMessageCalls = []
  mockLastTransport = null
})

describe('AppShellWebView', () => {
  it('passes a HostRequestedWebNavigation initialMessage for the route', () => {
    render(
      <AppShellWebView baseUrl="https://example.test" route="/apps" onRequestTunnel={() => {}} />
    )
    expect(mockLastUseTransportConfig?.initialMessages).toEqual([
      { _tag: 'HostRequestedWebNavigation', path: '/apps' },
    ])
  })

  it('does NOT place AuthTokenIssued in initialMessages even when a token is provided', () => {
    // The token would otherwise be encoded into the WebView URL as a
    // query parameter and leaked into native logs / Sentry breadcrumbs.
    render(
      <AppShellWebView
        baseUrl="https://example.test"
        route="/apps"
        token="bearer-xyz"
        onRequestTunnel={() => {}}
      />
    )
    expect(mockLastUseTransportConfig?.initialMessages).toEqual([
      { _tag: 'HostRequestedWebNavigation', path: '/apps' },
    ])
    const serialised = JSON.stringify(mockLastUseTransportConfig?.initialMessages)
    expect(serialised).not.toContain('bearer-xyz')
  })

  it('issues AuthTokenIssued through transport.sendMessage after mount', async () => {
    render(
      <AppShellWebView
        baseUrl="https://example.test"
        route="/apps"
        token="bearer-xyz"
        onRequestTunnel={() => {}}
      />
    )
    // `render` itself wraps the initial render in act, but the
    // `useEffect` that dispatches `AuthTokenIssued` schedules its
    // effect callback in the *next* microtask. Empty-bodied `act`
    // flushes that pending update without re-entering rendering.
    await act(async () => {})
    expect(mockSendMessageCalls).toContainEqual({ _tag: 'AuthTokenIssued', token: 'bearer-xyz' })
  })

  it('does not call sendMessage with AuthTokenIssued when no token is provided', async () => {
    render(
      <AppShellWebView baseUrl="https://example.test" route="/apps" onRequestTunnel={() => {}} />
    )
    await act(async () => {})
    const authCalls = mockSendMessageCalls.filter((m) => m._tag === 'AuthTokenIssued')
    expect(authCalls).toEqual([])
  })

  it('forwards baseUrl into useTransport', () => {
    render(
      <AppShellWebView baseUrl="https://example.test" route="/apps" onRequestTunnel={() => {}} />
    )
    expect(mockLastUseTransportConfig?.baseUrl).toBe('https://example.test')
  })

  it('builds a transport whose embedUrl carries the supplied baseUrl', () => {
    render(
      <AppShellWebView baseUrl="https://example.test" route="/apps" onRequestTunnel={() => {}} />
    )
    expect(mockLastTransport?.embedUrl).toContain('https://example.test')
  })

  it('renders with the full callback surface attached (smoke)', () => {
    const onRouteChanged = jest.fn()
    const onRequestSniffableWebView = jest.fn()
    const onCancelSnifferRequest = jest.fn()
    const onSniffingComplete = jest.fn()
    const onOpen = jest.fn()
    const onRawMessage = jest.fn()
    const onRequestTunnel = jest.fn()
    expect(() =>
      render(
        <AppShellWebView
          baseUrl="https://example.test"
          route="/apps"
          onRouteChanged={onRouteChanged}
          onRequestSniffableWebView={onRequestSniffableWebView}
          onCancelSnifferRequest={onCancelSnifferRequest}
          onSniffingComplete={onSniffingComplete}
          onOpen={onOpen}
          onRawMessage={onRawMessage}
          onRequestTunnel={onRequestTunnel}
        />
      )
    ).not.toThrow()
  })
})
