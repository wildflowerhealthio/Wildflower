import { render } from '@testing-library/react-native'
import * as React from 'react'

import type { ReactElement } from 'react'

// `jest.mock` factories are hoisted above imports and forbidden to read
// out-of-scope variables; `mock`-prefixed and pure-write outer references
// are exempt. `lastInjectedScript` is assigned inside the EmbeddedWebView
// mock and read in test bodies — pure-write inside the factory, so it
// passes the hoist guard.
//
// We replace `interop-expo` wholesale rather than spreading a real
// `requireActual('interop-expo')` because the real module's
// `embedded-webview.tsx` imports `react-native-webview`, which calls
// `TurboModuleRegistry.getEnforcing('RNCWebViewModule')` at module-load
// time and blows up without a native binary. Stubbing both
// `EmbeddedWebView` and `useMessageHandler` keeps the surface this test
// cares about (the injectedScript shape) intact while skipping the
// expo-tundraish / react-native-webview load chain.
let lastInjectedScript: string | undefined

jest.mock('interop-expo', () => {
  const ReactInner = jest.requireActual<typeof React>('react')
  return {
    EmbeddedWebView: (props: { readonly injectedScript?: string }): ReactElement => {
      lastInjectedScript = props.injectedScript
      return ReactInner.createElement('EmbeddedWebView', props)
    },
    useMessageHandler: ({
      initialMessages,
    }: {
      readonly initialMessages: ReadonlyArray<string>
    }): {
      readonly handler: {
        readonly setMessageListener: () => () => void
        readonly sendMessage: () => void
        readonly consumeBuffered: () => ReadonlyArray<unknown>
        readonly dispose: () => void
      }
      readonly webviewHandleRef: { current: null }
      readonly injectedScript: string
      readonly onMessage: () => void
    } => ({
      handler: {
        setMessageListener: () => (): void => undefined,
        sendMessage: (): void => undefined,
        consumeBuffered: (): ReadonlyArray<unknown> => [],
        dispose: (): void => undefined,
      },
      webviewHandleRef: { current: null },
      // Mirrors the real makeExpoMessageHandler's injectedScript form so
      // the assertions below see the same string shape.
      injectedScript: `window.__INITIAL_MESSAGES__ = ${JSON.stringify(initialMessages)}; true;`,
      onMessage: (): void => undefined,
    }),
  }
})

jest.mock('wildflower-react/embeddable-html', () => ({ html: '<!doctype html><html></html>' }))

import { GatekeeperWebView } from './GatekeeperWebView.tsx'

beforeEach(() => {
  lastInjectedScript = undefined
})

describe('GatekeeperWebView', () => {
  it('publishes __INITIAL_MESSAGES__ with an AppNavigationRequested for the route', () => {
    render(
      <GatekeeperWebView baseUrl="https://example.test" route="/gatekeeper/oauth-consent/abc" />
    )
    expect(lastInjectedScript).toContain('window.__INITIAL_MESSAGES__')
    // The injected script is `window.__INITIAL_MESSAGES__ = <json>; true;`,
    // where `<json>` is a JSON.stringify'd array of pre-encoded JSON
    // message strings — so every inner double-quote is backslash-escaped
    // by the outer encode. We match on bare substrings to dodge that.
    expect(lastInjectedScript).toContain('AppNavigationRequested')
    expect(lastInjectedScript).toContain('/gatekeeper/oauth-consent/abc')
  })

  it('includes an AuthTokenIssued entry when token is provided', () => {
    render(
      <GatekeeperWebView baseUrl="https://example.test" route="/gatekeeper" token="bearer-xyz" />
    )
    expect(lastInjectedScript).toContain('AuthTokenIssued')
    expect(lastInjectedScript).toContain('bearer-xyz')
  })

  it('omits the AuthTokenIssued entry when no token is passed', () => {
    render(<GatekeeperWebView baseUrl="https://example.test" route="/gatekeeper" />)
    expect(lastInjectedScript).not.toContain('AuthTokenIssued')
  })

  it('terminates the injected script with `true;` so RN does not warn about an undefined return value', () => {
    render(<GatekeeperWebView baseUrl="https://example.test" route="/gatekeeper" />)
    expect(lastInjectedScript?.trimEnd().endsWith('true;')).toBe(true)
  })
})
