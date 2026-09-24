import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import {
  browserSignInEnvironment,
  type ClientRegistration,
  type SignInPage,
} from './browser-environment.ts'

const REGISTRATION: ClientRegistration = {
  clientId: 'wildflower-react',
  pendingKey: 'wildflower-react.pending-authorization',
  scope: 'openid profile',
  redirectUri: 'https://wildflowerhealth.io/home',
}

/** A {@link SignInPage} whose impure edges are stubs a test can watch. */
const pageAt = (
  href: string,
  options: { readonly protocol?: string; readonly onFetch?: () => void } = {}
): SignInPage => ({
  fetch: function (this: unknown) {
    // Records the receiver the flow calls with: a real `Window.fetch` throws
    // `Illegal invocation` when it is called without one.
    if (this === undefined) throw new TypeError('Illegal invocation')
    options.onFetch?.()
    return Promise.resolve(new Response('{}'))
  },
  crypto: {
    getRandomValues: <T extends ArrayBufferView>(array: T): T => array,
    subtle: { digest: () => Promise.resolve(new ArrayBuffer(32)) },
  },
  sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  location: { href, protocol: options.protocol ?? 'https:' },
})

describe('browserSignInEnvironment', () => {
  it('calls the page’s fetch as a method, so a real Window keeps its receiver', async () => {
    // Arrange — the footgun this helper exists to hold: `fetch: page.fetch`
    // would hand the flow an unbound reference.
    let called = false
    const environment = browserSignInEnvironment(
      pageAt('https://wildflowerhealth.io/', {
        onFetch: () => {
          called = true
        },
      }),
      REGISTRATION
    )

    // Act
    await environment.fetch('https://example.test/.well-known/smart-configuration')

    // Assert
    expect(called).toBe(true)
  })

  it('reports the page as secure only on https', () => {
    // This decides whether a plaintext target is reachable at all, so it has to
    // follow the document and not a build flag.
    expect(browserSignInEnvironment(pageAt('https://x.test/'), REGISTRATION).pageIsSecure).toBe(
      true
    )
    expect(
      browserSignInEnvironment(
        pageAt('http://127.0.0.1:5173/', { protocol: 'http:' }),
        REGISTRATION
      ).pageIsSecure
    ).toBe(false)
  })

  it('property: carries every registered value through untouched', () => {
    // Each of these is the browser-side reading of a seeded `clients` row, so
    // the helper must not normalize, default or reorder any of them.
    fc.assert(
      fc.property(
        fc.record({
          clientId: fc.string(),
          pendingKey: fc.string(),
          scope: fc.string(),
          redirectUri: fc.string(),
        }),
        (registration) => {
          const environment = browserSignInEnvironment(pageAt('https://x.test/'), registration)
          expect(environment.clientId).toBe(registration.clientId)
          expect(environment.pendingKey).toBe(registration.pendingKey)
          expect(environment.scope).toBe(registration.scope)
          expect(environment.redirectUri).toBe(registration.redirectUri)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
