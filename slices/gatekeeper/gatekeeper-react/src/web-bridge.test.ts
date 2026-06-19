import { Effect } from 'effect'
import { describe, expect, test, vi } from 'vite-plus/test'
import { makeGatekeeperWebHandlers } from './web-bridge.ts'

describe('makeGatekeeperWebHandlers', () => {
  test('AuthTokenIssued pulls the current bearer and forwards a non-empty value through setToken', () => {
    const setToken = vi.fn<(token: string | null) => void>()
    const setActiveDeviceUserCode = vi.fn<(userCode: string | null) => void>()
    const pull = vi.fn(() => Effect.succeed<string | null>('a-bearer'))
    const handlers = makeGatekeeperWebHandlers(setToken, setActiveDeviceUserCode, pull)

    Effect.runSync(handlers.AuthTokenIssued({ _tag: 'AuthTokenIssued' }))

    expect(pull).toHaveBeenCalledTimes(1)
    expect(setToken).toHaveBeenCalledTimes(1)
    expect(setToken).toHaveBeenCalledWith('a-bearer')
    expect(setActiveDeviceUserCode).not.toHaveBeenCalled()
  })

  test('AuthTokenIssued leaves the store untouched when the pull resolves to null', () => {
    const setToken = vi.fn<(token: string | null) => void>()
    const setActiveDeviceUserCode = vi.fn<(userCode: string | null) => void>()
    const pull = vi.fn(() => Effect.succeed<string | null>(null))
    const handlers = makeGatekeeperWebHandlers(setToken, setActiveDeviceUserCode, pull)

    Effect.runSync(handlers.AuthTokenIssued({ _tag: 'AuthTokenIssued' }))

    expect(pull).toHaveBeenCalledTimes(1)
    expect(setToken).not.toHaveBeenCalled()
  })

  test('AuthTokenIssued drops an empty-string pull without rotating the store', () => {
    const setToken = vi.fn<(token: string | null) => void>()
    const setActiveDeviceUserCode = vi.fn<(userCode: string | null) => void>()
    const pull = vi.fn(() => Effect.succeed<string | null>(''))
    const handlers = makeGatekeeperWebHandlers(setToken, setActiveDeviceUserCode, pull)

    Effect.runSync(handlers.AuthTokenIssued({ _tag: 'AuthTokenIssued' }))

    expect(setToken).not.toHaveBeenCalled()
  })

  test('DeviceConsentRequested forwards a userCode into the active-consent setter', () => {
    const setToken = vi.fn<(token: string | null) => void>()
    const setActiveDeviceUserCode = vi.fn<(userCode: string | null) => void>()
    const pull = vi.fn(() => Effect.succeed<string | null>(null))
    const handlers = makeGatekeeperWebHandlers(setToken, setActiveDeviceUserCode, pull)

    Effect.runSync(
      handlers.DeviceConsentRequested({
        _tag: 'DeviceConsentRequested',
        userCode: 'ABC-123',
      })
    )

    expect(setActiveDeviceUserCode).toHaveBeenCalledTimes(1)
    expect(setActiveDeviceUserCode).toHaveBeenCalledWith('ABC-123')
    expect(setToken).not.toHaveBeenCalled()
    expect(pull).not.toHaveBeenCalled()
  })

  test('DeviceConsentRequested forwards null verbatim (the host-side clear sentinel)', () => {
    const setToken = vi.fn<(token: string | null) => void>()
    const setActiveDeviceUserCode = vi.fn<(userCode: string | null) => void>()
    const pull = vi.fn(() => Effect.succeed<string | null>(null))
    const handlers = makeGatekeeperWebHandlers(setToken, setActiveDeviceUserCode, pull)

    Effect.runSync(
      handlers.DeviceConsentRequested({ _tag: 'DeviceConsentRequested', userCode: null })
    )

    expect(setActiveDeviceUserCode).toHaveBeenCalledTimes(1)
    expect(setActiveDeviceUserCode).toHaveBeenCalledWith(null)
  })
})
