import { Effect } from 'effect'
import { describe, expect, test, vi } from 'vite-plus/test'
import { HOST_AUTHED_SIGNAL, makeGatekeeperWebHandlers } from './web-bridge.ts'

describe('makeGatekeeperWebHandlers', () => {
  test('AuthTokenIssued flips the auth-readiness signal with the non-secret marker', () => {
    const setToken = vi.fn<(token: string | null) => void>()
    const setActiveDeviceUserCode = vi.fn<(userCode: string | null) => void>()
    const handlers = makeGatekeeperWebHandlers(setToken, setActiveDeviceUserCode)

    Effect.runSync(handlers.AuthTokenIssued({ _tag: 'AuthTokenIssued' }))

    expect(setToken).toHaveBeenCalledTimes(1)
    expect(setToken).toHaveBeenCalledWith(HOST_AUTHED_SIGNAL)
    expect(setActiveDeviceUserCode).not.toHaveBeenCalled()
  })

  test('the signal carries no secret — it is a bare marker, never a JWT', () => {
    // Guards the invariant that the bearer never reaches the JS side: the
    // signal is a plain marker (no JWT dots), the credential is the cookie.
    expect(HOST_AUTHED_SIGNAL).not.toContain('.')
    expect(HOST_AUTHED_SIGNAL).not.toBe('')
  })

  test('DeviceConsentRequested forwards a userCode into the active-consent setter', () => {
    const setToken = vi.fn<(token: string | null) => void>()
    const setActiveDeviceUserCode = vi.fn<(userCode: string | null) => void>()
    const handlers = makeGatekeeperWebHandlers(setToken, setActiveDeviceUserCode)

    Effect.runSync(
      handlers.DeviceConsentRequested({
        _tag: 'DeviceConsentRequested',
        userCode: 'ABC-123',
      })
    )

    expect(setActiveDeviceUserCode).toHaveBeenCalledTimes(1)
    expect(setActiveDeviceUserCode).toHaveBeenCalledWith('ABC-123')
    expect(setToken).not.toHaveBeenCalled()
  })

  test('DeviceConsentRequested forwards null verbatim (the host-side clear sentinel)', () => {
    const setToken = vi.fn<(token: string | null) => void>()
    const setActiveDeviceUserCode = vi.fn<(userCode: string | null) => void>()
    const handlers = makeGatekeeperWebHandlers(setToken, setActiveDeviceUserCode)

    Effect.runSync(
      handlers.DeviceConsentRequested({ _tag: 'DeviceConsentRequested', userCode: null })
    )

    expect(setActiveDeviceUserCode).toHaveBeenCalledTimes(1)
    expect(setActiveDeviceUserCode).toHaveBeenCalledWith(null)
  })
})
