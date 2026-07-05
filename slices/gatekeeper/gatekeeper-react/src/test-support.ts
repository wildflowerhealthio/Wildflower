/**
 * Test-only fixture for the `wf_auth_exp` companion cookie the web auth store
 * reads. Extracted so `auth-state-store.test.ts` and the app's `web-entry.test.ts`
 * share ONE encoding of the cookie-hint contract — the name
 * ({@link AUTH_EXP_COOKIE_NAME}), `Path=/` scoping, and unix-seconds `exp`
 * format. Two independent copies would drift: a companion-cookie format change
 * could leave one suite green against a cookie the server no longer sets.
 *
 * Not exported from the package index — imported via `gatekeeper-react/test-support`.
 */
import { AUTH_EXP_COOKIE_NAME } from './client/auth-state-store.ts'

/**
 * A unix-seconds `exp` an hour in the future. The wide gap keeps the
 * future/past cases robust against however long a test takes to run.
 */
const futureAuthExp = (): string => String(Math.floor(Date.now() / 1000) + 3600)

/** A unix-seconds `exp` an hour in the past. */
const pastAuthExp = (): string => String(Math.floor(Date.now() / 1000) - 3600)

/** Plant the readable `wf_auth_exp` companion cookie with the server's `Path=/`. */
const setAuthExpCookie = (value: string): void => {
  document.cookie = `${AUTH_EXP_COOKIE_NAME}=${value}; Path=/`
}

/** Clear every cookie (`Max-Age=0`), mirroring the server's clear form. */
const clearAllCookies = (): void => {
  for (const part of document.cookie.split(';')) {
    const name = part.split('=')[0]?.trim()
    if (name !== undefined && name !== '') document.cookie = `${name}=; Path=/; Max-Age=0`
  }
}

export { AUTH_EXP_COOKIE_NAME, clearAllCookies, futureAuthExp, pastAuthExp, setAuthExpCookie }
