import { Effect, Equal } from 'effect'
import { type AuthState, type AuthStateStore, HostAuthed, Unauthed } from 'react-kitchen-sink'
import { describe, expect, test } from 'vite-plus/test'

import { makeEmbeddedAuthStateStore } from './auth-state-store.ts'

const read = (store: AuthStateStore): AuthState => Effect.runSync(store.subscribable.get)

/**
 * The embedded store holds no credential: seeded `Unauthed`, its sole writer is
 * the host's `AuthTokenIssued` bridge handler publishing `HostAuthed`. The host
 * authenticates the webview's loopback requests by connection provenance.
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
