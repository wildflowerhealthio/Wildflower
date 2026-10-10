import { redirectUriForPage, STANDALONE_LAUNCH_SCOPES } from 'gatekeeper-core/smart-client'
import { describe, expect, it } from 'vite-plus/test'

import { CLIENT_ID, PENDING_AUTHORIZATION_KEY, REGISTERED_REDIRECT_URI } from './smart-client.ts'

describe('the seeded client registration', () => {
  it('is the public PKCE client the gatekeeper migration seeds', () => {
    // The values the gatekeeper seed registers for the console — the client
    // id and the single `redirect_uris` entry `0028_rekey_site_app_clients`
    // re-keyed, and the scopes from `0007_seed_wildflower_server_docs_client`.
    // `/authorize` clamps the request to `allowed_scopes`, so drift between
    // these constants and the seed fails the flow outright.
    expect(CLIENT_ID).toBe('664a01e8614050cd82ffe90350b81413')
    expect(REGISTERED_REDIRECT_URI).toBe('https://wildflowerhealth.io/server-docs/')
    expect([...STANDALONE_LAUNCH_SCOPES]).toEqual([
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

  it('is what the published console derives for itself, byte for byte', () => {
    // The console no longer picks its redirect from a list — it derives one from
    // where it is served. For the published copy that derivation MUST land back
    // on the seeded entry, or the production console would present an
    // unregistered redirect and send every reader through a consent warning
    // that the seed exists to avoid.
    expect(redirectUriForPage(REGISTERED_REDIRECT_URI)).toBe(REGISTERED_REDIRECT_URI)
  })
})

describe('PENDING_AUTHORIZATION_KEY', () => {
  it('is namespaced to this console, not to the shared flow', () => {
    // `gatekeeper-core/smart-client` takes the key as a parameter precisely so
    // two Wildflower pages on `wildflowerhealth.io` cannot read each other's
    // pending record. A key that dropped the app prefix would undo that. The
    // prefix is the package's name, as the launcher's is: the client id is
    // random, so it names no app.
    expect(PENDING_AUTHORIZATION_KEY).toBe('server-docs-web.pending-authorization')
  })
})
