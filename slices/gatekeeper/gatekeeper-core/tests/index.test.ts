import { expect, test } from 'vite-plus/test'
import * as Gatekeeper from '../src/contexts/index.ts'

// Surface-snapshot: catches accidental removal of an exported helper that
// downstream adapters depend on. Failures here are intentional flags —
// when an export is removed on purpose, update the expected list and the
// reviewer can see the surface change in the diff.
test('contexts/index re-exports the published surface', () => {
  expect(Object.keys(Gatekeeper).toSorted()).toEqual(
    [
      'FIRST_PARTY_CLIENT_ID',
      'GatekeeperStore',
      'SeedFirstPartyClientLive',
      'approveAuthorizationRequest',
      'cleanupExpiredAuthorizationCodes',
      'cleanupExpiredAuthorizationRequests',
      'denyAuthorizationRequest',
      'makeGatekeeperStoreLayer',
      'seedFirstPartyClient',
    ].toSorted()
  )
})
