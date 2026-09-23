import { act, cleanup, render, screen } from '@testing-library/react'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import type { JSX } from 'react'
import {
  AuthedUntil,
  type AuthState,
  AuthStateProvider,
  HostAuthed,
  isFreshlyAuthed,
  Unauthed,
} from 'react-kitchen-sink'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'

import { makeEmbeddedAuthStateStore } from '../../../client/auth-state-store.ts'
import type { OAuthConsentResult } from '../../../queries/index.ts'

/**
 * Pins the `oauth-polling` stream consumer's rendering decisions:
 * `PollingResult` is the deterministic status→view mapping every stream
 * emission flows into (`{(status) => <PollingResult status={status} id={id} />}`).
 * Testing it directly covers the consumer's actual branch logic — denied
 * / error / pending views and the approved-redirect side effect — without
 * the Suspense + forked-fiber timing of the full stream subscription
 * (`useStream` itself is covered by its own tests in react-kitchen-sink).
 *
 * The pending branch delegates to `PendingView`, which is also tested
 * directly here: a *freshly* authenticated viewer gets the inline consent
 * form; an unauthenticated one — or one whose `AuthedUntil` has lapsed —
 * keeps the "Waiting for Approval" spinner,
 * and a genuine consent-query error is surfaced rather than hidden behind
 * that spinner.
 */

// Replace the suspense-fetching consent form with a marker that captures
// the `onDone` callback so the tests can drive the form's result branches
// (approved-with-redirect, approved-without, denied) directly — the same
// pattern device-consent-modal-host.test.tsx uses for its child form.
let lastFormDone: ((result: OAuthConsentResult) => void) | null = null
vi.mock('../../../screens/oauth-consent/oauth-consent-form.tsx', () => ({
  OAuthConsentForm: ({
    consent,
    onDone,
  }: {
    readonly consent: { readonly clientId: string }
    readonly onDone: (result: OAuthConsentResult) => void
  }): JSX.Element => {
    lastFormDone = onDone
    return <div data-testid="consent-form" data-client-id={consent.clientId} />
  },
}))

// When set, the (mocked) consent query throws synchronously during render
// — a failure the error boundary surfaces as the inline error view.
let consentQueryThrows = false
vi.mock('../../../queries/index.ts', () => ({
  useOAuthConsentQuery: (id: string) => {
    if (consentQueryThrows) throw new Error('unauthorized')
    return { data: { id, clientId: 'client-abc', scopes: [], patient: null } }
  },
}))

import { ExternalRedirect, PendingView } from './oauth-polling.$id.tsx'

// jsdom's `window.location.replace` is a non-configurable property, so it
// can't be spied directly. Swap the whole `location` for a stub exposing a
// `replace` spy (the only member the views touch), and restore the
// original after each test.
const originalLocation = window.location
const replaceSpy = vi.fn<(url: string) => void>()

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test stub: the views only read `location.replace`
const locationStub = { replace: replaceSpy } as unknown as Location

/** Render `ui` under an `<AuthStateProvider>` publishing `authState`. */
const renderWithAuth = (ui: JSX.Element, authState: AuthState): void => {
  const store = makeEmbeddedAuthStateStore()
  store.setAuthState(authState)
  render(<AuthStateProvider store={store}>{ui}</AuthStateProvider>)
}

beforeEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: locationStub })
  lastFormDone = null
  consentQueryThrows = false
})

afterEach(() => {
  cleanup()
  Object.defineProperty(window, 'location', { configurable: true, value: originalLocation })
  replaceSpy.mockReset()
})

describe('PendingView', () => {
  test('shows the spinner (no form) for an unauthenticated viewer', () => {
    renderWithAuth(<PendingView id="req-1" />, Unauthed())
    expect(screen.getByText('Waiting for Approval')).toBeTruthy()
    expect(screen.queryByTestId('consent-form')).toBeNull()
  })

  test('renders the inline consent form for an authenticated (host) viewer', () => {
    renderWithAuth(<PendingView id="req-1" />, HostAuthed())
    expect(screen.getByTestId('consent-form')).toBeTruthy()
    expect(screen.queryByText('Waiting for Approval')).toBeNull()
  })

  test('renders the form for a fresh AuthedUntil but the spinner for a lapsed one', () => {
    const nowSeconds = Date.now() / 1000

    renderWithAuth(<PendingView id="req-1" />, AuthedUntil({ exp: nowSeconds + 3600 }))
    expect(screen.getByTestId('consent-form')).toBeTruthy()
    cleanup()

    // A lapsed `AuthedUntil` (exp already past) is treated as unauthed: the
    // spinner, not a doomed inline fetch (issue #256).
    renderWithAuth(<PendingView id="req-1" />, AuthedUntil({ exp: nowSeconds - 1 }))
    expect(screen.getByText('Waiting for Approval')).toBeTruthy()
    expect(screen.queryByTestId('consent-form')).toBeNull()
  })

  test('form renders iff the auth signal is fresh (property)', () => {
    // The gate is `isFreshlyAuthed`: `Unauthed` and a lapsed `AuthedUntil`
    // show the spinner; `HostAuthed` and a future-`exp` `AuthedUntil` show the
    // form. Generate `exp`s well clear of "now" so the sub-second gap between
    // the component's clock read and the test's can't flip the verdict.
    const nowFloor = Math.floor(Date.now() / 1000)
    const anySignal: fc.Arbitrary<AuthState> = fc.oneof(
      fc.constant(Unauthed()),
      fc.constant(HostAuthed()),
      fc.integer({ min: 1, max: nowFloor - 10 }).map((exp) => AuthedUntil({ exp })),
      fc
        .integer({ min: nowFloor + 60, max: nowFloor + 1_000_000 })
        .map((exp) => AuthedUntil({ exp }))
    )
    fc.assert(
      fc.property(anySignal, (signal) => {
        const store = makeEmbeddedAuthStateStore()
        store.setAuthState(signal)
        render(
          <AuthStateProvider store={store}>
            <PendingView id="req-1" />
          </AuthStateProvider>
        )
        const hasForm = screen.queryByTestId('consent-form') !== null
        cleanup()
        return hasForm === isFreshlyAuthed(signal, Date.now() / 1000)
      }),
      { numRuns: numRunsFor({ base: 20 }) }
    )
  })

  test('onDone approved with a redirect navigates this viewer to the callback', () => {
    renderWithAuth(<PendingView id="req-1" />, HostAuthed())
    const redirect = 'https://client.example/cb?code=x&state=y'
    act(() => {
      lastFormDone?.({ status: 'approved', redirect })
    })
    expect(replaceSpy).toHaveBeenCalledWith(redirect)
  })

  test('onDone approved without a redirect leaves navigation to the stream (form stays)', () => {
    renderWithAuth(<PendingView id="req-1" />, HostAuthed())
    act(() => {
      lastFormDone?.({ status: 'approved' })
    })
    // No local navigation — the polling stream will observe `approved` and
    // `PollingResult`'s effect redirects. The form stays mounted meanwhile.
    expect(replaceSpy).not.toHaveBeenCalled()
    expect(screen.getByTestId('consent-form')).toBeTruthy()
  })

  test('onDone denied swaps the form for the declined view', () => {
    renderWithAuth(<PendingView id="req-1" />, HostAuthed())
    act(() => {
      lastFormDone?.({ status: 'denied' })
    })
    expect(screen.getByText('Request Declined')).toBeTruthy()
    expect(screen.queryByTestId('consent-form')).toBeNull()
  })

  test('surfaces a genuine consent-query error instead of an endless spinner', () => {
    // React logs the caught render error to console.error; silence it the
    // way the repo's other error-boundary tests do.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    consentQueryThrows = true

    // The viewer is genuinely (freshly) authed, so the freshness gate does not
    // apply — this is a real failure, and the boundary shows it rather than
    // hiding it behind the waiting-for-phone spinner.
    renderWithAuth(<PendingView id="req-1" />, HostAuthed())

    expect(screen.getByText('Authorization Error')).toBeTruthy()
    expect(screen.queryByText('Waiting for Approval')).toBeNull()
    expect(screen.queryByTestId('consent-form')).toBeNull()

    consoleError.mockRestore()
  })
})

describe('ExternalRedirect', () => {
  test('performs a full-page replace to the external callback and shows only the spinner', () => {
    const redirect = 'https://client.example/cb?code=abc&state=xyz'
    render(<ExternalRedirect href={redirect} />)

    // A real document-level navigation to the cross-origin callback (the SPA
    // router can't reach it), and no new UI beyond the holding spinner.
    expect(replaceSpy).toHaveBeenCalledWith(redirect)
    expect(screen.getByText('Waiting for Approval')).toBeTruthy()
  })
})
