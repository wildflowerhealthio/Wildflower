import { Effect } from 'effect'
import { AUTH_EXP_COOKIE_NAME } from 'gatekeeper-react'
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test'
import { stubTransport } from './bridges/transport-context.ts'
import { makeWebEntryOptions } from './web-entry.ts'

const futureExp = (): string => String(Math.floor(Date.now() / 1000) + 3600)

const setExpCookie = (value: string): void => {
  document.cookie = `${AUTH_EXP_COOKIE_NAME}=${value}; Path=/`
}

const clearCookies = (): void => {
  for (const part of document.cookie.split(';')) {
    const name = part.split('=')[0]?.trim()
    if (name !== undefined && name !== '') document.cookie = `${name}=; Path=/; Max-Age=0`
  }
}

describe('makeWebEntryOptions', () => {
  beforeEach(clearCookies)
  afterEach(clearCookies)

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
    const exp = futureExp()
    setExpCookie(exp)
    const { tokenStore } = makeWebEntryOptions()
    expect(Effect.runSync(tokenStore.subscribable.get)).toBe(exp)
  })

  test('bearerTokenSubscribable stays null even when authed (cookie auth, no header)', () => {
    setExpCookie(futureExp())
    const { bearerTokenSubscribable } = makeWebEntryOptions()
    if (bearerTokenSubscribable === undefined) {
      throw new Error('web entry must supply an explicit (null) bearer source')
    }
    expect(Effect.runSync(bearerTokenSubscribable.get)).toBe(null)
  })

  test('awaitAuthReady resolves once the auth cookie is present', async () => {
    setExpCookie(futureExp())
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
