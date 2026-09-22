import { Effect, Equal } from 'effect'
import { clearAllCookies, futureAuthExp, setAuthExpCookie } from 'gatekeeper-react/test-support'
import { AuthedUntil } from 'react-kitchen-sink'
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test'
import { stubTransport } from './bridges/transport-context.ts'
import { makeSingleWebEntryOptions } from './single-web-entry.ts'

describe('makeSingleWebEntryOptions', () => {
  beforeEach(clearAllCookies)
  afterEach(clearAllCookies)

  test('makeTransport resolves to the shared stub transport', async () => {
    const { makeTransport } = makeSingleWebEntryOptions()
    const transport = await makeTransport(
      () => {},
      () => {},
      () => {}
    )
    expect(transport).toBe(stubTransport)
  })

  test('tokenStore reflects the cookie-derived auth signal', () => {
    const exp = futureAuthExp()
    setAuthExpCookie(exp)
    const { tokenStore } = makeSingleWebEntryOptions()
    expect(
      Equal.equals(Effect.runSync(tokenStore.subscribable.get), AuthedUntil({ exp: Number(exp) }))
    ).toBe(true)
  })

  test('awaitAuthReady resolves once the auth cookie is present', async () => {
    setAuthExpCookie(futureAuthExp())
    const { awaitAuthReady } = makeSingleWebEntryOptions()
    // `awaitAuthReady` reads the store's subscribable, so a present auth
    // signal resolves the readiness gate without redirecting.
    await expect(awaitAuthReady(Promise.resolve())()).resolves.toBeUndefined()
  })

  test('awaitAuthReady rejects (device-login redirect) when unauthenticated', async () => {
    const { awaitAuthReady } = makeSingleWebEntryOptions()
    await expect(awaitAuthReady(Promise.resolve())()).rejects.toBeDefined()
  })

  test('each call builds an independent store', () => {
    const first = makeSingleWebEntryOptions()
    const second = makeSingleWebEntryOptions()
    expect(first.tokenStore).not.toBe(second.tokenStore)
  })
})
