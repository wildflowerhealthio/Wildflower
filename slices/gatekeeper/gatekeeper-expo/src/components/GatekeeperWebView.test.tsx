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
// We replace `interop-expo` wholesale because the real module's
// `embedded-webview.tsx` imports `react-native-webview`, which calls
// `TurboModuleRegistry.getEnforcing('RNCWebViewModule')` at module-load
// time and blows up without a native binary. Mocking `EmbeddedWebView`
// + `makeExpoTransport` keeps the surface this test cares about (the
// `initialMessages` GatekeeperWebView passes into the transport) intact
// while skipping the react-native-webview load chain.
//
// `makeExpoTransport`'s real return type is `Effect<Transport, never,
// Scope>`. We mirror that with an `Effect.succeed`; the component's
// `Effect.runSync(Scope.extend(...))` resolves it on the spot.
let mockLastInitialMessages: ReadonlyArray<unknown> | undefined

jest.mock('interop-expo', () => {
  const ReactInner = jest.requireActual<typeof React>('react')
  const Effect = jest.requireActual<typeof effectImportNamespace>('effect').Effect
  return {
    EmbeddedWebView: (props: { readonly injectedScript?: string }): ReactElement =>
      ReactInner.createElement('EmbeddedWebView', props),
    makeExpoTransport: (config: {
      readonly bridges: ReadonlyArray<unknown>
      readonly layers: ReadonlyArray<unknown>
      readonly initialMessages: ReadonlyArray<unknown>
    }) => {
      mockLastInitialMessages = config.initialMessages
      return Effect.succeed({
        sendMessage: (): unknown => Effect.void,
        webviewHandleRef: { current: null },
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
// these to call `.Native.ReceiverLayer({...})` and pass the result into
// the (mocked) `makeExpoTransport`, so a plain pass-through stub
// suffices.
//
// The factory body inlines the stub because hoisting forbids reading
// non-`mock`-prefixed outer references.
jest.mock('interop-core', () => ({
  NavigationBridge: {
    Native: { ReceiverLayer: (handlers: unknown): unknown => ({ handlers }) },
    Web: { ReceiverLayer: (handlers: unknown): unknown => ({ handlers }) },
  },
}))
jest.mock('gatekeeper-core/bridge', () => ({
  GatekeeperBridge: {
    Native: { ReceiverLayer: (handlers: unknown): unknown => ({ handlers }) },
    Web: { ReceiverLayer: (handlers: unknown): unknown => ({ handlers }) },
  },
}))

jest.mock('wildflower-react/embeddable-html', () => ({ html: '<!doctype html><html></html>' }))

import { GatekeeperWebView } from './GatekeeperWebView.tsx'

beforeEach(() => {
  mockLastInitialMessages = undefined
})

describe('GatekeeperWebView', () => {
  it('passes a NativeRequestedWebNavigation initialMessage for the route', () => {
    render(
      <GatekeeperWebView baseUrl="https://example.test" route="/gatekeeper/oauth-consent/abc" />
    )
    expect(mockLastInitialMessages).toEqual([
      { _tag: 'NativeRequestedWebNavigation', path: '/gatekeeper/oauth-consent/abc' },
    ])
  })

  it('appends an AuthTokenIssued initialMessage when a token is provided', () => {
    render(
      <GatekeeperWebView baseUrl="https://example.test" route="/gatekeeper" token="bearer-xyz" />
    )
    expect(mockLastInitialMessages).toEqual([
      { _tag: 'NativeRequestedWebNavigation', path: '/gatekeeper' },
      { _tag: 'AuthTokenIssued', token: 'bearer-xyz' },
    ])
  })

  it('omits the AuthTokenIssued initialMessage when no token is passed', () => {
    render(<GatekeeperWebView baseUrl="https://example.test" route="/gatekeeper" />)
    expect(mockLastInitialMessages).toEqual([
      { _tag: 'NativeRequestedWebNavigation', path: '/gatekeeper' },
    ])
  })
})
