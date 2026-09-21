import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import {
  CLIENT_ID,
  KNOWN_REDIRECT_URIS,
  LOCAL_DEV_REDIRECT_URI,
  PENDING_AUTHORIZATION_KEY,
  REGISTERED_REDIRECT_URI,
  REQUESTED_SCOPES,
  requestedScopeParameter,
  signInAvailability,
} from './smart-client.ts'

describe('the seeded client registration', () => {
  it('is the public PKCE client the gatekeeper migration seeds', () => {
    // The values the gatekeeper `wildflower-server-docs` seed registers — the
    // client id, the single `redirect_uris` entry and the scopes from
    // `0007_seed_wildflower_server_docs_client`. `/authorize` matches the
    // redirect by exact string equality and clamps the request to
    // `allowed_scopes`, so drift between these constants and the seed fails the
    // flow outright.
    expect(CLIENT_ID).toBe('wildflower-server-docs')
    expect(REGISTERED_REDIRECT_URI).toBe('https://wildflowerhealth.io/wildflower-server-docs/')
    expect([...REQUESTED_SCOPES]).toEqual([
      'openid',
      'profile',
      'fhirUser',
      'launch',
      'launch/patient',
      'offline_access',
      'wildflower/launch',
      'system/*.cruds',
      'wildflower/*.cruds',
    ])
  })
})

describe('the redirect URIs this console knows', () => {
  it('lists the seeded published URL first, then the un-seeded loopback dev server', () => {
    // Only the first entry is in `0007_seed_wildflower_server_docs_client`. The
    // loopback one is a developer convenience a server accepts on first use
    // through the Owner's consent (#688–#690), so this list is "what the console
    // knows how to return to", not "what is registered" — the seed is the
    // authority for the latter, and it carries exactly one entry.
    expect(LOCAL_DEV_REDIRECT_URI).toBe('http://127.0.0.1:5192')
    expect([...KNOWN_REDIRECT_URIS]).toEqual([REGISTERED_REDIRECT_URI, LOCAL_DEV_REDIRECT_URI])
  })
})

describe('PENDING_AUTHORIZATION_KEY', () => {
  it('is namespaced to this console, not to the shared flow', () => {
    // `gatekeeper-core/smart-client` takes the key as a parameter precisely so
    // two Wildflower pages on `wildflowerhealth.io` cannot read each other's
    // pending record. A key that dropped the app prefix would undo that.
    expect(PENDING_AUTHORIZATION_KEY).toBe('wildflower-server-docs.pending-authorization')
    expect(PENDING_AUTHORIZATION_KEY.startsWith(`${CLIENT_ID}.`)).toBe(true)
  })
})

describe('requestedScopeParameter', () => {
  it('joins the scopes the way RFC 6749 §3.3 asks for', () => {
    // Act / Assert
    expect(requestedScopeParameter().split(' ')).toEqual([...REQUESTED_SCOPES])
  })
})

describe('signInAvailability', () => {
  it('offers sign-in on the published console, returning its redirect URI', () => {
    // Act / Assert
    expect(signInAvailability(REGISTERED_REDIRECT_URI)).toEqual({
      available: true,
      redirectUri: REGISTERED_REDIRECT_URI,
    })
  })

  it('offers sign-in on the loopback dev server, returning its redirect URI', () => {
    // The dev server is reached at the loopback origin with the bare root path,
    // with or without the trailing slash the browser adds.
    expect(signInAvailability('http://127.0.0.1:5192/')).toEqual({
      available: true,
      redirectUri: LOCAL_DEV_REDIRECT_URI,
    })
    expect(signInAvailability('http://127.0.0.1:5192')).toEqual({
      available: true,
      redirectUri: LOCAL_DEV_REDIRECT_URI,
    })
  })

  it('offers sign-in whether or not the path carries its trailing slash', () => {
    // Act / Assert
    expect(signInAvailability('https://wildflowerhealth.io/wildflower-server-docs')).toEqual({
      available: true,
      redirectUri: REGISTERED_REDIRECT_URI,
    })
  })

  it('still offers sign-in when the reader has a server chosen or a section open', () => {
    // The query and fragment are the console's own state; only origin and path
    // decide whether the server would honour the redirect.
    expect(
      signInAvailability(
        'https://wildflowerhealth.io/wildflower-server-docs/?server=https%3A%2F%2Fx.test#tag/apps'
      )
    ).toEqual({ available: true, redirectUri: REGISTERED_REDIRECT_URI })
    expect(
      signInAvailability('http://127.0.0.1:5192/?server=https%3A%2F%2Fx.test#tag/apps')
    ).toEqual({ available: true, redirectUri: LOCAL_DEV_REDIRECT_URI })
  })

  it('never offers sign-in from a copy served anywhere else', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          'http://localhost:5173/',
          'http://127.0.0.1:4173/wildflower-server-docs/',
          // The loopback dev redirect is exact: a different host, a different
          // port, or a non-root path is none of the registered consoles.
          'http://localhost:5192/',
          'http://127.0.0.1:5193/',
          'http://127.0.0.1:5192/some-other-path',
          'https://wildflowerhealth.io/',
          'https://wildflowerhealth.io/wildflower-server-docs-preview/',
          'https://fork.github.io/wildflower-server-docs/',
          'https://evil.test/wildflower-server-docs/'
        ),
        (href) => {
          // Act
          const availability = signInAvailability(href)

          // Assert
          expect(availability.available).toBe(false)
        }
      ),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })

  it('explains itself when it cannot sign in', () => {
    // Act
    const availability = signInAvailability('http://localhost:5173/')

    // Assert
    if (availability.available) throw new Error('expected sign-in to be unavailable')
    expect(availability.reason).toContain(REGISTERED_REDIRECT_URI)
  })

  it('never calls an unrecognised copy unregistered', () => {
    // The console cannot know what a given server's client row holds — the seed
    // is one starting point, and the Owner may add a redirect on first use — so
    // "this page does not know how to return here" is the honest reason, and
    // "you are not registered" is not the console's to say.
    fc.assert(
      fc.property(
        fc.constantFrom(
          'http://localhost:5173/',
          'https://fork.github.io/wildflower-server-docs/',
          'https://wildflowerhealth.io/wildflower-server-docs-preview/'
        ),
        (href) => {
          // Act
          const availability = signInAvailability(href)

          // Assert
          if (availability.available) throw new Error('expected sign-in to be unavailable')
          expect(availability.reason.toLowerCase()).not.toContain('unregistered')
          expect(availability.reason.toLowerCase()).not.toContain('registered for')
        }
      ),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })

  it('refuses an address it cannot even parse', () => {
    // Act
    const availability = signInAvailability('not a url')

    // Assert
    expect(availability.available).toBe(false)
  })
})
