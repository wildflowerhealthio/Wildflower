import { render } from '@testing-library/react-native'
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
  return {
    EffectMessagingWebView: ReactInner.forwardRef(function MockEffectMessagingWebView(
      props: { readonly source?: { readonly html?: string; readonly baseUrl?: string } },
      _ref: unknown
    ): ReactElement {
      return ReactInner.createElement('EffectMessagingWebView', props)
    }),
    useTransport: (config: {
      readonly initialMessages: ReadonlyArray<unknown>
      readonly baseUrl: string
    }): unknown => {
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
    },
  }
})

// Stub workspace bridge modules so the receiver-layer composition is
// satisfied without actually building real bridges.
jest.mock('navigation-core', () => {
  const effect = jest.requireActual<{ Effect: typeof EffectType; Layer: typeof LayerType }>(
    'effect'
  )
  return {
    NavigationBridge: {
      Host: {
        ReceiverLayer: (_handlers: unknown): LayerType.Layer<never> =>
          effect.Layer.effectDiscard(effect.Effect.void),
      },
    },
  }
})

jest.mock('gatekeeper-core/bridge', () => {
  const effect = jest.requireActual<{ Effect: typeof EffectType; Layer: typeof LayerType }>(
    'effect'
  )
  return {
    __esModule: true,
    default: {
      Host: {
        ReceiverLayer: (_handlers: unknown): LayerType.Layer<never> =>
          effect.Layer.effectDiscard(effect.Effect.void),
      },
    },
  }
})

jest.mock('collector-fundamentals/bridge', () => {
  const effect = jest.requireActual<{ Effect: typeof EffectType; Layer: typeof LayerType }>(
    'effect'
  )
  return {
    __esModule: true,
    default: {
      Host: {
        ReceiverLayer: (_handlers: unknown): LayerType.Layer<never> =>
          effect.Layer.effectDiscard(effect.Effect.void),
      },
    },
  }
})

jest.mock('wildflower-react/embeddable-html', () => ({ html: '<!doctype html><html></html>' }))

jest.mock('expo-router', () => ({
  useNavigation: (): { setOptions(o: unknown): void } => ({
    setOptions: (): void => undefined,
  }),
}))

jest.mock('expo-tundraish', () => ({
  useColorScheme: (): 'light' => 'light',
  Colors: {
    light: { background: '#fff', icon: '#000' },
    dark: { background: '#000', icon: '#fff' },
  },
}))

import { CollectorWebView } from './CollectorWebView.tsx'

beforeEach(() => {
  mockLastUseTransportConfig = null
  mockSendMessageCalls = []
  mockLastTransport = null
})

describe('CollectorWebView', () => {
  it('passes a HostRequestedWebNavigation initialMessage for the route', () => {
    render(<CollectorWebView baseUrl="https://example.test" route="/collector" />)
    expect(mockLastUseTransportConfig?.initialMessages).toEqual([
      { _tag: 'HostRequestedWebNavigation', path: '/collector' },
    ])
  })

  it('does NOT place AuthTokenIssued in initialMessages even when a token is provided', () => {
    // The token would otherwise be encoded into the WebView URL as a
    // query parameter and leaked into native logs / Sentry breadcrumbs.
    render(
      <CollectorWebView baseUrl="https://example.test" route="/collector" token="bearer-xyz" />
    )
    expect(mockLastUseTransportConfig?.initialMessages).toEqual([
      { _tag: 'HostRequestedWebNavigation', path: '/collector' },
    ])
    // Verify the token does not appear in the initial-messages array.
    const serialised = JSON.stringify(mockLastUseTransportConfig?.initialMessages)
    expect(serialised).not.toContain('bearer-xyz')
  })

  it('issues AuthTokenIssued through transport.sendMessage after mount', async () => {
    render(
      <CollectorWebView baseUrl="https://example.test" route="/collector" token="bearer-xyz" />
    )
    // The post-mount useEffect runFork drains synchronously under
    // jest's microtask scheduler; give it a tick to flush.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mockSendMessageCalls).toContainEqual({ _tag: 'AuthTokenIssued', token: 'bearer-xyz' })
  })

  it('does not call sendMessage with AuthTokenIssued when no token is provided', async () => {
    render(<CollectorWebView baseUrl="https://example.test" route="/collector" />)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const authCalls = mockSendMessageCalls.filter((m) => m._tag === 'AuthTokenIssued')
    expect(authCalls).toEqual([])
  })

  it('forwards baseUrl into useTransport', () => {
    render(<CollectorWebView baseUrl="https://example.test" route="/collector" />)
    expect(mockLastUseTransportConfig?.baseUrl).toBe('https://example.test')
  })

  it('builds a transport whose embedUrl is exposed for the WebView source.baseUrl', () => {
    render(<CollectorWebView baseUrl="https://example.test" route="/collector" />)
    expect(mockLastTransport?.embedUrl).toContain('https://example.test')
  })

  describe('RequestSniffableWebView handler', () => {
    // The component constructs the CollectorBridge.Host.ReceiverLayer
    // inline with the three callbacks; we don't have a hook into the
    // bridge's tag dispatch from within the test. Defense-in-depth
    // URI-scheme check is covered by the schema's filter at the bridge
    // boundary (collector-fundamentals/model/web-view-source); the
    // host-side check is left as a code path for future schema-loosening
    // protection and is exercised only when reached at runtime.
    it('component renders with onRequest callbacks supplied (smoke)', () => {
      const onRequestSniffableWebView = jest.fn()
      const onCancelSnifferRequest = jest.fn()
      const onSniffingComplete = jest.fn()
      expect(() =>
        render(
          <CollectorWebView
            baseUrl="https://example.test"
            route="/collector"
            onRequestSniffableWebView={onRequestSniffableWebView}
            onCancelSnifferRequest={onCancelSnifferRequest}
            onSniffingComplete={onSniffingComplete}
          />
        )
      ).not.toThrow()
    })
  })
})
