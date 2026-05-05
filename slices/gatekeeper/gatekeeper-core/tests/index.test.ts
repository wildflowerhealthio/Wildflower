import { expect, test } from 'vite-plus/test'
import * as Gatekeeper from '../src/contexts/index.ts'

test('root exports consent decision functions', () => {
  expect(typeof Gatekeeper.approveAuthorizationRequest).toBe('function')
  expect(typeof Gatekeeper.denyAuthorizationRequest).toBe('function')
  expect(typeof Gatekeeper.verifyPinChallenge).toBe('function')
  expect(typeof Gatekeeper.denyPinChallenge).toBe('function')
})
