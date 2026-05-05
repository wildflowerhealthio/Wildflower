import { expect, test } from 'vite-plus/test'
import * as Gatekeeper from '../src/contexts/index.ts'

test('root exports consent decision functions and seed helpers', () => {
  expect(typeof Gatekeeper.approveAuthorizationRequest).toBe('function')
  expect(typeof Gatekeeper.denyAuthorizationRequest).toBe('function')
  expect(typeof Gatekeeper.seedFirstPartyClient).toBe('object')
  expect(Gatekeeper.FIRST_PARTY_CLIENT_ID).toBe('wildflower-host')
})
