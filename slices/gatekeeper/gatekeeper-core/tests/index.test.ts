import { expect, test } from 'vite-plus/test'
import * as Auth from '../src/contexts/index.ts'

test('root exports consent decision functions', () => {
  expect(typeof Auth.approveAuthorizationRequest).toBe('function')
  expect(typeof Auth.denyAuthorizationRequest).toBe('function')
  expect(typeof Auth.verifyPinChallenge).toBe('function')
  expect(typeof Auth.denyPinChallenge).toBe('function')
})
