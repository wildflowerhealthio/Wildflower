import { render } from '@testing-library/react-native'
import * as React from 'react'

import type { ReactElement } from 'react'

// `jest.mock` factories are hoisted above imports and forbidden to
// reference out-of-scope variables, so the React module is pulled
// from `jest.requireActual` inside the factory rather than from the
// outer `React` import.
jest.mock('expo-tundraish', () => {
  const ReactInner = jest.requireActual<typeof React>('react')
  return {
    EmbeddedWebView: (props: { readonly injectedScript?: string }): ReactElement => {
      lastInjectedScript = props.injectedScript
      return ReactInner.createElement('EmbeddedWebView', props)
    },
  }
})

jest.mock('wildflower-react/embeddable-html', () => ({ html: '<!doctype html><html></html>' }))

import { GatekeeperWebView } from './GatekeeperWebView.tsx'

let lastInjectedScript: string | undefined

beforeEach(() => {
  lastInjectedScript = undefined
})

describe('GatekeeperWebView', () => {
  it('injects the initial route', () => {
    render(
      <GatekeeperWebView baseUrl="https://example.test" route="/gatekeeper/oauth-consent/abc" />
    )
    expect(lastInjectedScript).toContain(
      'window.__INITIAL_ROUTE__ = "/gatekeeper/oauth-consent/abc"'
    )
  })

  it('injects the bearer token when provided so the embedded SPA can authenticate', () => {
    render(
      <GatekeeperWebView baseUrl="https://example.test" route="/gatekeeper" token="bearer-xyz" />
    )
    expect(lastInjectedScript).toContain('window.__GATEKEEPER_TOKEN__ = "bearer-xyz"')
  })

  it('omits the token injection when no token is passed', () => {
    render(<GatekeeperWebView baseUrl="https://example.test" route="/gatekeeper" />)
    expect(lastInjectedScript).not.toContain('window.__GATEKEEPER_TOKEN__')
  })

  it('serializes initialData as a JSON literal', () => {
    render(
      <GatekeeperWebView
        baseUrl="https://example.test"
        route="/gatekeeper"
        initialData={{ user: 'alice' }}
      />
    )
    expect(lastInjectedScript).toContain('window.__GATEKEEPER_INITIAL__ = {"user":"alice"}')
  })

  it('terminates the injected script with `true;` so RN does not warn about an undefined return value', () => {
    render(<GatekeeperWebView baseUrl="https://example.test" route="/gatekeeper" />)
    expect(lastInjectedScript?.trimEnd().endsWith('true;')).toBe(true)
  })
})
