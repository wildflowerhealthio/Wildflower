import { Effect, Equal } from 'effect'
import type { PendingConsentHead } from 'gatekeeper-core/bridge'
import { type AuthState, HostAuthed } from 'react-kitchen-sink'
import { describe, expect, test, vi } from 'vite-plus/test'

import { makeGatekeeperWebHandlers } from './web-bridge.ts'

const makeSpies = (): {
  setAuthState: ReturnType<typeof vi.fn<(signal: AuthState) => void>>
  setActivePendingConsent: ReturnType<typeof vi.fn<(head: PendingConsentHead | null) => void>>
} => ({
  setAuthState: vi.fn<(signal: AuthState) => void>(),
  setActivePendingConsent: vi.fn<(head: PendingConsentHead | null) => void>(),
})

describe('makeGatekeeperWebHandlers', () => {
  test('AuthTokenIssued flips the auth-readiness signal to HostAuthed', () => {
    const { setAuthState, setActivePendingConsent } = makeSpies()
    const handlers = makeGatekeeperWebHandlers(setAuthState, setActivePendingConsent)

    Effect.runSync(handlers.AuthTokenIssued({ _tag: 'AuthTokenIssued' }))

    // `HostAuthed` — authed with no page-known expiry — is the only signal this
    // platform can make: the host attaches the credential to loopback requests
    // itself, so the JS side never holds a JWT.
    expect(setAuthState).toHaveBeenCalledTimes(1)
    const [signal] = setAuthState.mock.calls[0] ?? []
    expect(signal !== undefined && Equal.equals(signal, HostAuthed())).toBe(true)
    expect(setActivePendingConsent).not.toHaveBeenCalled()
  })

  // The head is forwarded verbatim — including its `kind`, which is what the
  // modal host branches on to pick a consent form and endpoint. `null` is
  // meaningful (the host's clear sentinel), not an absent value to guard away.
  test.each([
    { label: 'a device head', head: { kind: 'device', userCode: 'ABC-123' } as const },
    { label: 'an oauth head', head: { kind: 'oauth', id: 'req-1' } as const },
    { label: 'the clear sentinel', head: null },
  ])('PendingConsentRequested forwards $label into the active-consent setter', ({ head }) => {
    const { setAuthState, setActivePendingConsent } = makeSpies()
    const handlers = makeGatekeeperWebHandlers(setAuthState, setActivePendingConsent)

    Effect.runSync(handlers.PendingConsentRequested({ _tag: 'PendingConsentRequested', head }))

    expect(setActivePendingConsent).toHaveBeenCalledTimes(1)
    expect(setActivePendingConsent).toHaveBeenCalledWith(head)
    expect(setAuthState).not.toHaveBeenCalled()
  })
})
