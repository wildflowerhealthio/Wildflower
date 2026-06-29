import { Effect } from 'effect'
import type { AuthTokenStore } from 'react-kitchen-sink'
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test'
import {
  AUTH_EXP_COOKIE_NAME,
  makeEmbeddedAuthTokenStore,
  makeWebAuthTokenStore,
  readAuthedSignalFromCookie,
} from './token-storage.ts'

/**
 * The web store derives its auth signal from the readable `wf_auth_exp`
 * companion cookie the server sets alongside the `HttpOnly` `wf_auth` JWT
 * (#218). JS never sees the real token; these tests drive the cookie
 * directly and assert the derived signal. A wide (1h) gap between `exp` and
 * "now" keeps the future/past cases robust against test execution time.
 */

const unixSecs = (): number => Math.floor(Date.now() / 1000)
const futureExp = (): string => String(unixSecs() + 3600)
const pastExp = (): string => String(unixSecs() - 3600)

const setExpCookie = (value: string): void => {
  document.cookie = `${AUTH_EXP_COOKIE_NAME}=${value}; Path=/`
}

const clearCookies = (): void => {
  for (const part of document.cookie.split(';')) {
    const name = part.split('=')[0]?.trim()
    if (name !== undefined && name !== '') document.cookie = `${name}=; Path=/; Max-Age=0`
  }
}

const read = (store: AuthTokenStore): string | null => Effect.runSync(store.subscribable.get)

beforeEach(clearCookies)
afterEach(clearCookies)

describe('readAuthedSignalFromCookie', () => {
  test('returns the exp string while the hint is in the future', () => {
    const exp = futureExp()
    setExpCookie(exp)
    expect(readAuthedSignalFromCookie()).toBe(exp)
  })

  test('returns null when no companion cookie is present', () => {
    expect(readAuthedSignalFromCookie()).toBe(null)
  })

  test('returns null once the hint has expired', () => {
    setExpCookie(pastExp())
    expect(readAuthedSignalFromCookie()).toBe(null)
  })

  test('returns null for a non-numeric exp', () => {
    setExpCookie('not-a-number')
    expect(readAuthedSignalFromCookie()).toBe(null)
  })

  test('reads wf_auth_exp from among other cookies', () => {
    const exp = futureExp()
    document.cookie = 'other=1; Path=/'
    setExpCookie(exp)
    document.cookie = 'another=2; Path=/'
    expect(readAuthedSignalFromCookie()).toBe(exp)
  })
})

describe('makeWebAuthTokenStore', () => {
  test('starts authed (the exp hint) when the cookie is present at construction', () => {
    const exp = futureExp()
    setExpCookie(exp)
    expect(read(makeWebAuthTokenStore())).toBe(exp)
  })

  test('starts unauthed (null) when no cookie is present', () => {
    expect(read(makeWebAuthTokenStore())).toBe(null)
  })

  test('starts unauthed when the cookie is already expired', () => {
    setExpCookie(pastExp())
    expect(read(makeWebAuthTokenStore())).toBe(null)
  })

  test('setToken re-derives the signal from the cookie, ignoring its argument', () => {
    const store = makeWebAuthTokenStore()
    expect(read(store)).toBe(null)

    // The server set the HttpOnly cookie on the device-flow response; the
    // companion exp now reads back. JS can't (and must not) plant the JWT, so
    // the value passed to setToken is intentionally ignored.
    const exp = futureExp()
    setExpCookie(exp)
    store.setToken('a-raw-jwt-the-web-store-must-never-hold')

    expect(read(store)).toBe(exp)
  })

  test('the subscribable never carries a usable bearer — only the non-secret exp', () => {
    const exp = futureExp()
    setExpCookie(exp)
    // A JWT has dots; the exp hint is bare digits. This guards the invariant
    // that the web auth signal is not a token.
    const signal = read(makeWebAuthTokenStore())
    expect(signal).toBe(exp)
    expect(signal?.includes('.')).toBe(false)
  })
})

/**
 * The embedded store holds the raw JWT in memory (the host bridge is the
 * sole writer) and is unchanged by #218 — the embedded path keeps attaching
 * the `Authorization` header because `tauri://` fetches loopback
 * cross-origin where cookies don't travel cleanly (point 8).
 */
describe('makeEmbeddedAuthTokenStore', () => {
  test('starts at null', () => {
    expect(read(makeEmbeddedAuthTokenStore())).toBe(null)
  })

  test('setToken stores the raw token in memory', () => {
    const store = makeEmbeddedAuthTokenStore()
    store.setToken('from-host-bridge')
    expect(read(store)).toBe('from-host-bridge')
  })
})
