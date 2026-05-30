import { expect, test } from 'vite-plus/test'
import * as Gatekeeper from './index.ts'

// Surface snapshot: removals show up in the diff.
test('contexts/index re-exports the published surface', () => {
  expect(Object.keys(Gatekeeper).toSorted()).toEqual(
    [
      'FIRST_PARTY_CLIENT_ID',
      'approveAuthorizationRequest',
      'cleanupExpiredAuthorizationCodes',
      'cleanupExpiredAuthorizationRequests',
      'denyAuthorizationRequest',
      'mintHostOwnerToken',
      'seedFirstPartyClient',
      'seedSigningKey',
    ].toSorted()
  )
})
