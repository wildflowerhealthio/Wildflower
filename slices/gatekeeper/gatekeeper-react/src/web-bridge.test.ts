import { Effect } from 'effect'
import { describe, expect, test, vi } from 'vite-plus/test'
import { makeGatekeeperWebHandlers } from './web-bridge.ts'

describe('makeGatekeeperWebHandlers', () => {
  test('AuthTokenIssued forwards a non-empty token through setToken', () => {
    const setToken = vi.fn<(token: string | null) => void>()
    const handlers = makeGatekeeperWebHandlers(setToken)

    Effect.runSync(
      handlers.AuthTokenIssued({ _tag: 'AuthTokenIssued', token: 'a-bearer' })
    )

    expect(setToken).toHaveBeenCalledTimes(1)
    expect(setToken).toHaveBeenCalledWith('a-bearer')
  })

  test('AuthTokenIssued drops the empty-string sentinel without rotating the store', () => {
    const setToken = vi.fn<(token: string | null) => void>()
    const handlers = makeGatekeeperWebHandlers(setToken)

    Effect.runSync(
      handlers.AuthTokenIssued({ _tag: 'AuthTokenIssued', token: '' })
    )

    expect(setToken).not.toHaveBeenCalled()
  })
})
