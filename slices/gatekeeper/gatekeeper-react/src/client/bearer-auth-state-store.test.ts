import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { AuthedUntil, type AuthState, Unauthed } from '@wildflowerhealthio/react-kitchen-sink'
import { Effect, Equal } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { makeBearerAuthStateStore } from './bearer-auth-state-store.ts'

const read = (store: {
  readonly subscribable: { readonly get: Effect.Effect<AuthState> }
}): AuthState => Effect.runSync(store.subscribable.get)

/** The key the test stores keep their server under. */
const SERVER_URL_KEY = 'test.signed-in-server'

const RUTH_SERVER_URL = 'https://ruth.relay.wildflowerhealth.io'

/** An in-memory stand-in for the tab's `sessionStorage`. */
const memoryStorage = (): Pick<Storage, 'getItem' | 'setItem'> => {
  const entries = new Map<string, string>()
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value)
    },
  }
}

const freshStore = (): ReturnType<typeof makeBearerAuthStateStore> =>
  makeBearerAuthStateStore(memoryStorage(), SERVER_URL_KEY)

describe('makeBearerAuthStateStore', () => {
  test('starts Unauthed with no server and no bearer', () => {
    const store = freshStore()

    expect(Equal.equals(read(store), Unauthed())).toBe(true)
    expect(store.serverUrl()).toBeUndefined()
    expect(store.bearer()).toBeUndefined()
  })

  test('writeSession holds the server and the bearer together without publishing an auth signal', () => {
    // The signal is the caller's to set: only it knows whether the token
    // response reported a lifetime to put in an `AuthedUntil`.
    const store = freshStore()

    store.writeSession({ serverUrl: RUTH_SERVER_URL, bearer: 'tok_silent' })

    expect(store.serverUrl()).toBe(RUTH_SERVER_URL)
    expect(store.bearer()).toBe('tok_silent')
    expect(Equal.equals(read(store), Unauthed())).toBe(true)
  })

  test('the server outlives a reload, the bearer does not', () => {
    // Arrange
    const storage = memoryStorage()
    makeBearerAuthStateStore(storage, SERVER_URL_KEY).writeSession({
      serverUrl: RUTH_SERVER_URL,
      bearer: 'tok_abc',
    })

    // Act — the page reloads, building a fresh store over the same storage.
    const reloaded = makeBearerAuthStateStore(storage, SERVER_URL_KEY)

    // Assert
    expect(reloaded.serverUrl()).toBe(RUTH_SERVER_URL)
    expect(reloaded.bearer()).toBeUndefined()
  })

  test('setAuthState(Unauthed) clears the bearer and keeps the server', () => {
    const store = freshStore()
    store.writeSession({ serverUrl: RUTH_SERVER_URL, bearer: 'tok_abc' })
    store.setAuthState(AuthedUntil({ exp: 9999 }))

    store.setAuthState(Unauthed())

    expect(store.bearer()).toBeUndefined()
    expect(store.serverUrl()).toBe(RUTH_SERVER_URL)
    expect(Equal.equals(read(store), Unauthed())).toBe(true)
  })

  test('setAuthState(AuthedUntil) publishes without changing the session', () => {
    const store = freshStore()
    store.writeSession({ serverUrl: RUTH_SERVER_URL, bearer: 'tok_pre' })

    store.setAuthState(AuthedUntil({ exp: 5000 }))

    expect(store.serverUrl()).toBe(RUTH_SERVER_URL)
    expect(store.bearer()).toBe('tok_pre')
    expect(Equal.equals(read(store), AuthedUntil({ exp: 5000 }))).toBe(true)
  })

  test('property: writeSession then setAuthState(AuthedUntil) composes correctly', () => {
    fc.assert(
      fc.property(fc.webUrl(), fc.string({ minLength: 1 }), fc.nat(), (serverUrl, token, exp) => {
        const store = freshStore()
        store.writeSession({ serverUrl, bearer: token })
        store.setAuthState(AuthedUntil({ exp }))

        expect(store.serverUrl()).toBe(serverUrl)
        expect(store.bearer()).toBe(token)
        expect(Equal.equals(read(store), AuthedUntil({ exp }))).toBe(true)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: Unauthed always clears the bearer regardless of prior state', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.nat(), (token, exp) => {
        const store = freshStore()
        store.writeSession({ serverUrl: RUTH_SERVER_URL, bearer: token })
        store.setAuthState(AuthedUntil({ exp }))
        store.setAuthState(Unauthed())

        expect(store.bearer()).toBeUndefined()
        expect(Equal.equals(read(store), Unauthed())).toBe(true)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
