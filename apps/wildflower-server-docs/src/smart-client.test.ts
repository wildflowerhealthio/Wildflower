import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import {
  CLIENT_ID,
  REGISTERED_REDIRECT_URI,
  REQUESTED_SCOPES,
  requestedScopeParameter,
  signInAvailability,
} from './smart-client.ts'

describe('the seeded client registration', () => {
  it('is the public PKCE client the gatekeeper migration seeds', () => {
    // The values `0007_seed_wildflower_server_docs_client` inserts. `/authorize`
    // matches the redirect URI by exact string equality and clamps the request
    // to `allowed_scopes`, so drift here fails the flow outright.
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

describe('requestedScopeParameter', () => {
  it('joins the scopes the way RFC 6749 §3.3 asks for', () => {
    // Act / Assert
    expect(requestedScopeParameter().split(' ')).toEqual([...REQUESTED_SCOPES])
  })
})

describe('signInAvailability', () => {
  it('offers sign-in on the published console', () => {
    // Act / Assert
    expect(signInAvailability(REGISTERED_REDIRECT_URI)).toEqual({ available: true })
  })

  it('offers sign-in whether or not the path carries its trailing slash', () => {
    // Act / Assert
    expect(signInAvailability('https://wildflowerhealth.io/wildflower-server-docs')).toEqual({
      available: true,
    })
  })

  it('still offers sign-in when the reader has a server chosen or a section open', () => {
    // The query and fragment are the console's own state; only origin and path
    // decide whether the server would honour the redirect.
    expect(
      signInAvailability(
        'https://wildflowerhealth.io/wildflower-server-docs/?server=https%3A%2F%2Fx.test#tag/apps'
      )
    ).toEqual({ available: true })
  })

  it('never offers sign-in from a copy served anywhere else', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          'http://localhost:5173/',
          'http://127.0.0.1:4173/wildflower-server-docs/',
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

  it('refuses an address it cannot even parse', () => {
    // Act
    const availability = signInAvailability('not a url')

    // Assert
    expect(availability.available).toBe(false)
  })
})
