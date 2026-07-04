import { Effect, Equal } from 'effect'
import { clearAllCookies, futureAuthExp, setAuthExpCookie } from 'gatekeeper-react/test-support'
import { AuthedUntil } from 'react-kitchen-sink'
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test'
import { stubTransport } from './bridges/transport-context.ts'
import { makeWebEntryOptions } from './web-entry.ts'

describe('makeWebEntryOptions', () => {
  beforeEach(clearAllCookies)
  afterEach(clearAllCookies)

  test('makeTransport resolves to the shared stub transport', async () => {
    const { makeTransport } = makeWebEntryOptions()
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
    const { tokenStore } = makeWebEntryOptions()
    expect(
      Equal.equals(Effect.runSync(tokenStore.subscribable.get), AuthedUntil({ exp: Number(exp) }))
    ).toBe(true)
  })

  test('awaitAuthReady resolves once the auth cookie is present', async () => {
    setAuthExpCookie(futureAuthExp())
    const { awaitAuthReady } = makeWebEntryOptions()
    // `awaitAuthReady` reads the store's subscribable, so a present auth
    // signal resolves the readiness gate without redirecting.
    await expect(awaitAuthReady(Promise.resolve())()).resolves.toBeUndefined()
  })

  test('awaitAuthReady rejects (device-login redirect) when unauthenticated', async () => {
    const { awaitAuthReady } = makeWebEntryOptions()
    await expect(awaitAuthReady(Promise.resolve())()).rejects.toBeDefined()
  })

  test('each call builds an independent store', () => {
    const first = makeWebEntryOptions()
    const second = makeWebEntryOptions()
    expect(first.tokenStore).not.toBe(second.tokenStore)
  })
})
