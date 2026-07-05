import { Effect, Equal } from 'effect'
import {
  AuthedUntil,
  type AuthState,
  type AuthStateStore,
  HostAuthed,
  Unauthed,
} from 'react-kitchen-sink'
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test'

import { clearAllCookies, futureAuthExp, pastAuthExp, setAuthExpCookie } from '../test-support.ts'
import {
  makeEmbeddedAuthStateStore,
  makeWebAuthStateStore,
  readAuthedSignalFromCookie,
} from './auth-state-store.ts'

/**
 * The web store derives its {@link AuthState} from the readable `wf_auth_exp`
 * companion cookie the server sets alongside the `HttpOnly` `wf_auth` JWT
 * (#218). JS never sees the real token; these tests drive the cookie directly
 * (via the shared `test-support` fixture) and assert the derived signal.
 */

const read = (store: AuthStateStore): AuthState => Effect.runSync(store.subscribable.get)

beforeEach(clearAllCookies)
afterEach(clearAllCookies)

describe('readAuthedSignalFromCookie', () => {
  test('returns AuthedUntil(exp) while the hint is in the future', () => {
    const exp = futureAuthExp()
    setAuthExpCookie(exp)
    expect(Equal.equals(readAuthedSignalFromCookie(), AuthedUntil({ exp: Number(exp) }))).toBe(true)
  })

  test('returns Unauthed when no companion cookie is present', () => {
    expect(Equal.equals(readAuthedSignalFromCookie(), Unauthed())).toBe(true)
  })

  test('returns Unauthed once the hint has expired', () => {
    setAuthExpCookie(pastAuthExp())
    expect(Equal.equals(readAuthedSignalFromCookie(), Unauthed())).toBe(true)
  })

  test('returns Unauthed for a non-numeric exp', () => {
    setAuthExpCookie('not-a-number')
    expect(Equal.equals(readAuthedSignalFromCookie(), Unauthed())).toBe(true)
  })

  test('returns Unauthed for an empty exp value', () => {
    // A just-cleared companion (`wf_auth_exp=`) reads back empty — treated as
    // absent, not `AuthedUntil(NaN)`.
    setAuthExpCookie('')
    expect(Equal.equals(readAuthedSignalFromCookie(), Unauthed())).toBe(true)
  })

  test('reads wf_auth_exp from among other cookies', () => {
    const exp = futureAuthExp()
    document.cookie = 'other=1; Path=/'
    setAuthExpCookie(exp)
    document.cookie = 'another=2; Path=/'
    expect(Equal.equals(readAuthedSignalFromCookie(), AuthedUntil({ exp: Number(exp) }))).toBe(true)
  })
})

describe('makeWebAuthStateStore', () => {
  test('starts AuthedUntil(exp) when the cookie is present at construction', () => {
    const exp = futureAuthExp()
    setAuthExpCookie(exp)
    expect(Equal.equals(read(makeWebAuthStateStore()), AuthedUntil({ exp: Number(exp) }))).toBe(
      true
    )
  })

  test('starts Unauthed when no cookie is present', () => {
    expect(Equal.equals(read(makeWebAuthStateStore()), Unauthed())).toBe(true)
  })

  test('starts Unauthed when the cookie is already expired', () => {
    setAuthExpCookie(pastAuthExp())
    expect(Equal.equals(read(makeWebAuthStateStore()), Unauthed())).toBe(true)
  })

  test('setAuthState re-derives the signal from the cookie, ignoring its argument', () => {
    const store = makeWebAuthStateStore()
    expect(Equal.equals(read(store), Unauthed())).toBe(true)

    // The server set the HttpOnly cookie on the device-flow response; the
    // companion exp now reads back. JS can't (and must not) plant the JWT, so
    // the argument to setAuthState is intentionally ignored and the cookie wins.
    const exp = futureAuthExp()
    setAuthExpCookie(exp)
    store.setAuthState(HostAuthed())

    expect(Equal.equals(read(store), AuthedUntil({ exp: Number(exp) }))).toBe(true)
  })

  test('the signal is a typed AuthedUntil carrying only the non-secret exp — never a JWT', () => {
    const exp = futureAuthExp()
    setAuthExpCookie(exp)
    const signal = read(makeWebAuthStateStore())
    expect(signal._tag).toBe('AuthedUntil')
    if (signal._tag === 'AuthedUntil') expect(signal.exp).toBe(Number(exp))
  })
})

/**
 * The embedded store holds no credential either: seeded `Unauthed`, its sole
 * writer is the host's `AuthTokenIssued` bridge handler publishing `HostAuthed`.
 * The credential is the `wf_auth` cookie the host syncs into the webview's jar.
 */
describe('makeEmbeddedAuthStateStore', () => {
  test('starts Unauthed', () => {
    expect(Equal.equals(read(makeEmbeddedAuthStateStore()), Unauthed())).toBe(true)
  })

  test('setAuthState publishes the host-pushed signal', () => {
    const store = makeEmbeddedAuthStateStore()
    store.setAuthState(HostAuthed())
    expect(Equal.equals(read(store), HostAuthed())).toBe(true)
  })
})
