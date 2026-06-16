import { Effect } from 'effect'
import { describe, expect, test, vi } from 'vite-plus/test'
import { makeGatekeeperWebHandlers } from './web-bridge.ts'

describe('makeGatekeeperWebHandlers', () => {
  test('AuthTokenIssued forwards a non-empty token through setToken', () => {
    const setToken = vi.fn<(token: string | null) => void>()
    const setActiveDeviceUserCode = vi.fn<(userCode: string | null) => void>()
    const handlers = makeGatekeeperWebHandlers(setToken, setActiveDeviceUserCode)

    Effect.runSync(handlers.AuthTokenIssued({ _tag: 'AuthTokenIssued', token: 'a-bearer' }))

    expect(setToken).toHaveBeenCalledTimes(1)
    expect(setToken).toHaveBeenCalledWith('a-bearer')
    expect(setActiveDeviceUserCode).not.toHaveBeenCalled()
  })

  test('AuthTokenIssued drops the empty-string sentinel without rotating the store', () => {
    const setToken = vi.fn<(token: string | null) => void>()
    const setActiveDeviceUserCode = vi.fn<(userCode: string | null) => void>()
    const handlers = makeGatekeeperWebHandlers(setToken, setActiveDeviceUserCode)

    Effect.runSync(handlers.AuthTokenIssued({ _tag: 'AuthTokenIssued', token: '' }))

    expect(setToken).not.toHaveBeenCalled()
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
