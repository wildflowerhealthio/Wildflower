import { Effect, Equal } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { AuthedUntil, type AuthState, Unauthed } from 'react-kitchen-sink'
import { describe, expect, test } from 'vite-plus/test'

import { makeBearerAuthStateStore } from './bearer-auth-state-store.ts'

const read = (store: {
  readonly subscribable: { readonly get: Effect.Effect<AuthState> }
}): AuthState => Effect.runSync(store.subscribable.get)

describe('makeBearerAuthStateStore', () => {
  test('starts Unauthed with no bearer', () => {
    const store = makeBearerAuthStateStore()

    expect(Equal.equals(read(store), Unauthed())).toBe(true)
    expect(store.bearer()).toBeUndefined()
  })

  test('writeBearer sets the bearer and publishes AuthedUntil', () => {
    const store = makeBearerAuthStateStore()

    store.writeBearer('tok_abc', 9999)

    expect(store.bearer()).toBe('tok_abc')
    expect(Equal.equals(read(store), AuthedUntil({ exp: 9999 }))).toBe(true)
  })

  test('storeBearer sets the bearer without publishing an auth signal', () => {
    const store = makeBearerAuthStateStore()

    store.storeBearer('tok_silent')

    expect(store.bearer()).toBe('tok_silent')
    expect(Equal.equals(read(store), Unauthed())).toBe(true)
  })

  test('setAuthState(Unauthed) clears the bearer', () => {
    const store = makeBearerAuthStateStore()
    store.writeBearer('tok_abc', 9999)

    store.setAuthState(Unauthed())

    expect(store.bearer()).toBeUndefined()
    expect(Equal.equals(read(store), Unauthed())).toBe(true)
  })

  test('setAuthState(AuthedUntil) publishes without changing the bearer', () => {
    const store = makeBearerAuthStateStore()
    store.storeBearer('tok_pre')

    store.setAuthState(AuthedUntil({ exp: 5000 }))

    expect(store.bearer()).toBe('tok_pre')
    expect(Equal.equals(read(store), AuthedUntil({ exp: 5000 }))).toBe(true)
  })

  test('property: writeBearer round-trips any token and exp', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.nat(), (token, exp) => {
        const store = makeBearerAuthStateStore()
        store.writeBearer(token, exp)

        expect(store.bearer()).toBe(token)
        expect(Equal.equals(read(store), AuthedUntil({ exp }))).toBe(true)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: storeBearer then setAuthState(AuthedUntil) composes correctly', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.nat(), (token, exp) => {
        const store = makeBearerAuthStateStore()
        store.storeBearer(token)
        store.setAuthState(AuthedUntil({ exp }))

        expect(store.bearer()).toBe(token)
        expect(Equal.equals(read(store), AuthedUntil({ exp }))).toBe(true)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: Unauthed always clears the bearer regardless of prior state', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.nat(), (token, exp) => {
        const store = makeBearerAuthStateStore()
        store.writeBearer(token, exp)
        store.setAuthState(Unauthed())

        expect(store.bearer()).toBeUndefined()
        expect(Equal.equals(read(store), Unauthed())).toBe(true)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
