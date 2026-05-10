import { render } from '@testing-library/react-native'
import * as React from 'react'

import type { ReactElement } from 'react'

// Mock `effect-messaging-expo` wholesale: the real module loads
// `react-native-webview`, which fails outside a native runtime.
// `mock`-prefixed names are hoisted-exempt for the babel-plugin-jest-hoist.
let mockLastUseTransportConfig: {
  readonly initialMessages: ReadonlyArray<unknown>
} | null = null

let mockLastWebViewProps: {
  readonly source?: { readonly html?: string; readonly baseUrl?: string }
  readonly injectedScript?: string
  readonly onMessage?: (event: unknown) => void
} | null = null

let mockLastTransport: {
  readonly injectedScript: string
  readonly onMessage: (event: unknown) => void
  readonly sendMessage: () => unknown
} | null = null

jest.mock('effect-messaging-expo', () => {
  const ReactInner = jest.requireActual<typeof React>('react')
  return {
    EffectMessagingWebView: ReactInner.forwardRef(function MockEffectMessagingWebView(
      props: {
        readonly source?: { readonly html?: string; readonly baseUrl?: string }
        readonly injectedScript?: string
        readonly onMessage?: (event: unknown) => void
      },
      _ref: unknown
    ): ReactElement {
      mockLastWebViewProps = props
      return ReactInner.createElement('EffectMessagingWebView', props)
    }),
    useTransport: (config: { readonly initialMessages: ReadonlyArray<unknown> }): unknown => {
      mockLastUseTransportConfig = config
      const transport = {
        sendMessage: (): unknown => undefined,
        injectedScript: 'window.__INITIAL_MESSAGES__ = []; true;',
        onMessage: (): void => undefined,
      }
      mockLastTransport = transport
      return transport
    },
  }
})

// Stub workspace bridge modules: babel-jest transforms their pnpm-symlinked dists
// and fails to find `@babel/runtime/helpers/interopRequireDefault`.
jest.mock('navigation-core', () => ({
  NavigationBridge: {
    Host: { ReceiverLayer: (handlers: unknown): unknown => ({ handlers }) },
    Web: { ReceiverLayer: (handlers: unknown): unknown => ({ handlers }) },
  },
}))
jest.mock('gatekeeper-core/bridge', () => ({
  __esModule: true,
  default: {
    Host: { ReceiverLayer: (handlers: unknown): unknown => ({ handlers }) },
    Web: { ReceiverLayer: (handlers: unknown): unknown => ({ handlers }) },
  },
}))

jest.mock('wildflower-react/embeddable-html', () => ({ html: '<!doctype html><html></html>' }))

jest.mock('expo-router', () => ({
  useNavigation: (): { setOptions(o: unknown): void } => ({
    setOptions: (): void => undefined,
  }),
}))

// Stub `expo-tundraish` to dodge its barrel; reanimated/vector-icons trip TurboModules in jest.
jest.mock('expo-tundraish', () => ({
  useColorScheme: (): 'light' => 'light',
  Colors: {
    light: { background: '#fff', icon: '#000' },
    dark: { background: '#000', icon: '#fff' },
  },
}))

import { GatekeeperWebView } from './GatekeeperWebView.tsx'

beforeEach(() => {
  mockLastUseTransportConfig = null
  mockLastWebViewProps = null
  mockLastTransport = null
})

describe('GatekeeperWebView', () => {
  it('passes a HostRequestedWebNavigation initialMessage for the route', () => {
    render(
      <GatekeeperWebView baseUrl="https://example.test" route="/gatekeeper/oauth-consent/abc" />
    )
    expect(mockLastUseTransportConfig?.initialMessages).toEqual([
      { _tag: 'HostRequestedWebNavigation', path: '/gatekeeper/oauth-consent/abc' },
    ])
  })

  it('appends an AuthTokenIssued initialMessage when a token is provided', () => {
    render(
      <GatekeeperWebView baseUrl="https://example.test" route="/gatekeeper" token="bearer-xyz" />
    )
    expect(mockLastUseTransportConfig?.initialMessages).toEqual([
      { _tag: 'HostRequestedWebNavigation', path: '/gatekeeper' },
      { _tag: 'AuthTokenIssued', token: 'bearer-xyz' },
    ])
  })

  it('omits the AuthTokenIssued initialMessage when no token is passed', () => {
    render(<GatekeeperWebView baseUrl="https://example.test" route="/gatekeeper" />)
    expect(mockLastUseTransportConfig?.initialMessages).toEqual([
      { _tag: 'HostRequestedWebNavigation', path: '/gatekeeper' },
    ])
  })

  it('forwards baseUrl into the EffectMessagingWebView source', () => {
    render(<GatekeeperWebView baseUrl="https://example.test" route="/gatekeeper" />)
    expect(mockLastWebViewProps?.source).toEqual({
      html: '<!doctype html><html></html>',
      baseUrl: 'https://example.test',
    })
  })

  it('forwards transport.injectedScript and transport.onMessage through to the WebView', () => {
    render(<GatekeeperWebView baseUrl="https://example.test" route="/gatekeeper" />)
    expect(mockLastWebViewProps?.injectedScript).toBe('window.__INITIAL_MESSAGES__ = []; true;')
    expect(mockLastWebViewProps?.onMessage).toBe(mockLastTransport?.onMessage)
  })
})
