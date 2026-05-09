import { render } from '@testing-library/react-native'
import type * as effectImportNamespace from 'effect'
import * as React from 'react'

import type { ReactElement } from 'react'

// `jest.mock` factories are hoisted above imports and forbidden to read
// out-of-scope variables; `mock`-prefixed and pure-write outer references
// are exempt. `mockLastInitialMessages` is assigned inside the
// `makeExpoTransport` mock and read in test bodies — pure-write inside
// the factory, so it passes the hoist guard.
//
// We replace `effect-messaging-expo` wholesale because the real module's
// `effect-messaging-webview.tsx` imports `react-native-webview`, which
// calls `TurboModuleRegistry.getEnforcing('RNCWebViewModule')` at
// module-load time and blows up without a native binary. Mocking
// `EffectMessagingWebView`
// + `makeExpoTransport` keeps the surface this test cares about (the
// `initialMessages` GatekeeperWebView passes into the transport) intact
// while skipping the react-native-webview load chain.
//
// `makeExpoTransport`'s real return type is `Effect<Transport, never,
// Scope>`. We mirror that with an `Effect.succeed`; the component's
// `Effect.runSync(Scope.extend(...))` resolves it on the spot.
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

// Stub the bridge modules so jest doesn't pull their tsdown-built ESM
// dists through babel-jest. The transform output references
// `@babel/runtime/helpers/interopRequireDefault` from a node_modules
// path next to the dist; pnpm-symlinked workspace packages resolve to
// `slices/.../dist/`, which doesn't have one. The component only uses
// these to call `.Host.ReceiverLayer({...})` and pass the result into
// the (mocked) `makeExpoTransport`, so a plain pass-through stub
// suffices.
//
// The factory body inlines the stub because hoisting forbids reading
// non-`mock`-prefixed outer references.
jest.mock('contracts-core', () => ({
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

// `useNavigation` is the only `expo-router` surface this component
// reaches for (header-chevron mounting). Stub setOptions as a no-op.
jest.mock('expo-router', () => ({
  useNavigation: (): { setOptions(o: unknown): void } => ({
    setOptions: (): void => undefined,
  }),
}))

// Stub `expo-tundraish` to dodge its barrel — re-exporting reanimated
// and vector-icons-backed components would trip the TurboModule chain
// in jest. The component only reaches for `Colors` (static data) and
// `useColorScheme` (returns a literal here).
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
