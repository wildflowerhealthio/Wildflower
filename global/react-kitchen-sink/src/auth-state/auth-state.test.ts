import { describe, expect, it } from 'vite-plus/test'

import { AuthedUntil, HostAuthed, isAuthed, isFreshlyAuthed, Unauthed } from './auth-state.ts'

describe('isAuthed', () => {
  it('is false only for Unauthed', () => {
    expect(isAuthed(Unauthed())).toBe(false)
    expect(isAuthed(AuthedUntil({ exp: 0 }))).toBe(true)
    expect(isAuthed(HostAuthed())).toBe(true)
  })
})

describe('isFreshlyAuthed', () => {
  const now = 1_000

  it('is false for Unauthed regardless of time', () => {
    expect(isFreshlyAuthed(Unauthed(), now)).toBe(false)
  })

  it('treats an AuthedUntil with a future expiry as fresh', () => {
    expect(isFreshlyAuthed(AuthedUntil({ exp: now + 1 }), now)).toBe(true)
  })

  it('treats an AuthedUntil at or before now as not fresh', () => {
    // A lapsed expiry that `isAuthed` would still count as authed.
    expect(isFreshlyAuthed(AuthedUntil({ exp: now }), now)).toBe(false)
    expect(isFreshlyAuthed(AuthedUntil({ exp: now - 1 }), now)).toBe(false)
    expect(isAuthed(AuthedUntil({ exp: now - 1 }))).toBe(true)
  })

  it('treats HostAuthed as always fresh (no page-known expiry)', () => {
    expect(isFreshlyAuthed(HostAuthed(), now)).toBe(true)
  })
})
