import { expect, test } from 'vite-plus/test'
import * as Auth from '../src/contexts/index.ts'

test('root exports control functions', () => {
  expect(typeof Auth.addAuthRequestListener).toBe('function')
  expect(typeof Auth.approveAuthRequest).toBe('function')
  expect(typeof Auth.declineAuthRequest).toBe('function')
  expect(typeof Auth.addPinAuthListener).toBe('function')
  expect(typeof Auth.approvePinAuth).toBe('function')
  expect(typeof Auth.declinePinAuth).toBe('function')
})
