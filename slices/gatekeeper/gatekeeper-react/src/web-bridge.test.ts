import { Effect, Equal } from 'effect'
import { type AuthState, HostAuthed } from 'react-kitchen-sink'
import { describe, expect, test, vi } from 'vite-plus/test'

import { makeGatekeeperWebHandlers } from './web-bridge.ts'

describe('makeGatekeeperWebHandlers', () => {
  test('AuthTokenIssued flips the auth-readiness signal to HostAuthed', () => {
    const setAuthState = vi.fn<(signal: AuthState) => void>()
    const setActiveDeviceUserCode = vi.fn<(userCode: string | null) => void>()
    const handlers = makeGatekeeperWebHandlers(setAuthState, setActiveDeviceUserCode)

    Effect.runSync(handlers.AuthTokenIssued({ _tag: 'AuthTokenIssued' }))

    // `HostAuthed` — authed with no page-known expiry — is the only signal this
    // platform can make: the credential is the host-synced cookie, never a JWT
    // on the JS side.
    expect(setAuthState).toHaveBeenCalledTimes(1)
    const [signal] = setAuthState.mock.calls[0] ?? []
    expect(signal !== undefined && Equal.equals(signal, HostAuthed())).toBe(true)
    expect(setActiveDeviceUserCode).not.toHaveBeenCalled()
  })

  test('DeviceConsentRequested forwards a userCode into the active-consent setter', () => {
    const setAuthState = vi.fn<(signal: AuthState) => void>()
    const setActiveDeviceUserCode = vi.fn<(userCode: string | null) => void>()
    const handlers = makeGatekeeperWebHandlers(setAuthState, setActiveDeviceUserCode)

    Effect.runSync(
      handlers.DeviceConsentRequested({
        _tag: 'DeviceConsentRequested',
        userCode: 'ABC-123',
      })
    )

    expect(setActiveDeviceUserCode).toHaveBeenCalledTimes(1)
    expect(setActiveDeviceUserCode).toHaveBeenCalledWith('ABC-123')
    expect(setAuthState).not.toHaveBeenCalled()
  })

  test('DeviceConsentRequested forwards null verbatim (the host-side clear sentinel)', () => {
    const setAuthState = vi.fn<(signal: AuthState) => void>()
    const setActiveDeviceUserCode = vi.fn<(userCode: string | null) => void>()
    const handlers = makeGatekeeperWebHandlers(setAuthState, setActiveDeviceUserCode)

    Effect.runSync(
      handlers.DeviceConsentRequested({ _tag: 'DeviceConsentRequested', userCode: null })
    )

    expect(setActiveDeviceUserCode).toHaveBeenCalledTimes(1)
    expect(setActiveDeviceUserCode).toHaveBeenCalledWith(null)
  })
})
