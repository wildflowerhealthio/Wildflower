import { render } from '@testing-library/react-native'
import type * as effectImportNamespace from 'effect'
import * as React from 'react'

import type { ReactElement } from 'react'

// Mock `effect-messaging-expo` wholesale: the real module loads `react-native-webview`,
// which fails outside a native runtime. `mockLastInitialMessages` is `mock`-prefixed
// for the babel-plugin-jest-hoist exemption.
let mockLastInitialMessages: ReadonlyArray<unknown> | undefined

jest.mock('effect-messaging-expo', () => {
  const ReactInner = jest.requireActual<typeof React>('react')
  const Effect = jest.requireActual<typeof effectImportNamespace>('effect').Effect
  return {
    EffectMessagingWebView: (props: { readonly injectedScript?: string }): ReactElement =>
      ReactInner.createElement('EffectMessagingWebView', props),
    makeExpoTransport: (config: {
      readonly bridges: ReadonlyArray<unknown>
      readonly layers: ReadonlyArray<unknown>
      readonly initialMessages: ReadonlyArray<unknown>
      readonly webviewHandleRef: { current: unknown }
    }) => {
      mockLastInitialMessages = config.initialMessages
      return Effect.succeed({
        sendMessage: (): unknown => Effect.void,
        injectedScript: '',
        onMessage: (): void => undefined,
      })
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
  mockLastInitialMessages = undefined
})

describe('GatekeeperWebView', () => {
  it('passes a HostRequestedWebNavigation initialMessage for the route', () => {
    render(
      <GatekeeperWebView baseUrl="https://example.test" route="/gatekeeper/oauth-consent/abc" />
    )
    expect(mockLastInitialMessages).toEqual([
      { _tag: 'HostRequestedWebNavigation', path: '/gatekeeper/oauth-consent/abc' },
    ])
  })

  it('appends an AuthTokenIssued initialMessage when a token is provided', () => {
    render(
      <GatekeeperWebView baseUrl="https://example.test" route="/gatekeeper" token="bearer-xyz" />
    )
    expect(mockLastInitialMessages).toEqual([
      { _tag: 'HostRequestedWebNavigation', path: '/gatekeeper' },
      { _tag: 'AuthTokenIssued', token: 'bearer-xyz' },
    ])
  })

  it('omits the AuthTokenIssued initialMessage when no token is passed', () => {
    render(<GatekeeperWebView baseUrl="https://example.test" route="/gatekeeper" />)
    expect(mockLastInitialMessages).toEqual([
      { _tag: 'HostRequestedWebNavigation', path: '/gatekeeper' },
    ])
  })
})
