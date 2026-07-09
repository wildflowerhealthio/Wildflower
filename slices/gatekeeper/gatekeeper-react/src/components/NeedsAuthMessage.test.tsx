import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { Effect, Layer, SubscriptionRef } from 'effect'
import * as fc from 'fast-check'
import { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import { numRunsFor } from 'kitchen-sink/test'
import type { JSX, ReactNode } from 'react'
import {
  type AuthState,
  AuthStateProvider,
  type AuthStateStore,
  Unauthed,
} from 'react-kitchen-sink'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

/**
 * Pins the `NeedsAuthMessage` stream/fiber consumer: the screen first shows a
 * setup form (device name + scope picker), and only on "Start sign-in" runs the
 * RFC 8628 device-authorization flow against the composed runtime layer, walking
 * the `DeviceFlowState` machine as the gatekeeper client resolves. A regression
 * in how the screen gates, forks the flow, reads the `DeviceAuthorization`
 * response, or maps a thrown error to a terminal state would otherwise go
 * uncaught.
 *
 * The runtime layer is mocked to a stubbed `GatekeeperHttpApiClient`, so the flow
 * runs end-to-end with no HTTP — only the device-authorization leg is exercised
 * (the token-exchange leg never resolves in these stubs, which is fine: the
 * assertions target the `pending`/`error` states the flow reaches first).
 */

// Only the methods the device flow touches are stubbed; the rest of the
// client shape is never read on these paths. The single assertion-time
// cast keeps the stub minimal instead of re-declaring the whole API.
const makeClientLayer = (oauth: {
  readonly DeviceAuthorization: (input: unknown) => Effect.Effect<unknown, unknown>
  readonly TokenExchange: (input: unknown) => Effect.Effect<unknown, unknown>
}): Layer.Layer<GatekeeperHttpApiClient> =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test stub: only `oauth.DeviceAuthorization`/`TokenExchange` are touched on these paths
  Layer.succeed(GatekeeperHttpApiClient, { oauth } as GatekeeperHttpApiClient['Type'])

const layerHolder: { current: Layer.Layer<GatekeeperHttpApiClient> } = {
  current: Layer.die('no client layer set for test'),
}

// Stands in for the host-threaded `localGrantedScopes` router-context value.
// `undefined` (the default) exercises the component's standalone fallback; a
// set value proves the request forwards the injected config.
const scopesHolder: { current: string | undefined } = { current: undefined }

vi.mock('../router-context.ts', () => ({
  useGatekeeperRuntimeLayer: (): Layer.Layer<GatekeeperHttpApiClient> => layerHolder.current,
  useGatekeeperLocalGrantedScopes: (): string | undefined => scopesHolder.current,
}))

// The device flow publishes the freshly-authed signal through the
// `AuthStateStore.setAuthState` it pulled from the surrounding
// `<AuthStateProvider>` (via `useAuthStateSetter`). Tests wrap the
// rendered subject in `withTokenStore(...)` so the assertions can
// observe the write through `setAuthStateMock` without poking
// `auth-state-store` directly.
const setAuthStateMock = vi.fn<(signal: AuthState) => void>()
const tokenRef = Effect.runSync(SubscriptionRef.make<AuthState>(Unauthed()))
const testTokenStore: AuthStateStore = {
  subscribable: tokenRef,
  setAuthState: (signal) => setAuthStateMock(signal),
}
const withTokenStore = (children: ReactNode): JSX.Element => (
  <AuthStateProvider store={testTokenStore}>{children}</AuthStateProvider>
)

const { NeedsAuthMessage, sanitizeReturnTo } = await import('./NeedsAuthMessage.tsx')

const PENDING_FOREVER = Effect.never

afterEach(() => {
  cleanup()
  setAuthStateMock.mockReset()
  scopesHolder.current = undefined
})

/** The canned RFC 8628 §3.2 device-authorization response the stubs return. */
const DEVICE_AUTH_RESPONSE = {
  user_code: 'WDJB-MJHT',
  device_code: 'dev-1',
  verification_uri: 'https://example.com/device',
  verification_uri_complete: 'https://example.com/device?code=WDJB-MJHT',
  interval: 5,
}

/** Click the form's "Start sign-in" button to launch the flow. */
const startSignIn = async (): Promise<void> => {
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Start sign-in' }))
}

describe('<NeedsAuthMessage> device flow', () => {
  test('shows the setup form on landing and fires no I/O until "Start sign-in"', () => {
    let called = false
    layerHolder.current = makeClientLayer({
      DeviceAuthorization: () => {
        called = true
        return PENDING_FOREVER
      },
      TokenExchange: () => PENDING_FOREVER,
    })

    render(withTokenStore(<NeedsAuthMessage />))

    // The flow is user-gated: the first paint is the form, not the spinner, and
    // nothing has hit the device-authorization endpoint yet.
    expect(screen.getByText('Set up this device')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Start sign-in' })).toBeTruthy()
    expect(called).toBe(false)
  })

  test('surfaces the user_code once device authorization resolves', async () => {
    layerHolder.current = makeClientLayer({
      DeviceAuthorization: () => Effect.succeed(DEVICE_AUTH_RESPONSE),
      // Never resolves: the flow parks in the `pending` state showing the code.
      TokenExchange: () => PENDING_FOREVER,
    })

    render(withTokenStore(<NeedsAuthMessage />))
    await startSignIn()

    await waitFor(
      () => {
        expect(screen.getByText('WDJB-MJHT')).toBeTruthy()
      },
      { timeout: 2000 }
    )
    expect(screen.getByText('Sign in on another device')).toBeTruthy()
  })

  test('forwards the typed device name and omits scope when nothing was picked', async () => {
    // The picker starts empty (the user builds the request from scratch), so the
    // built scope set is empty ⇒ no `scope` is sent; the typed name rides along.
    let capturedInput: unknown
    layerHolder.current = makeClientLayer({
      DeviceAuthorization: (input) => {
        capturedInput = input
        return Effect.succeed(DEVICE_AUTH_RESPONSE)
      },
      TokenExchange: () => PENDING_FOREVER,
    })

    const user = userEvent.setup()
    render(withTokenStore(<NeedsAuthMessage />))
    await user.type(screen.getByRole('textbox', { name: /Device name/ }), 'Ada')
    await user.click(screen.getByRole('button', { name: 'Start sign-in' }))

    await waitFor(
      () => {
        expect(capturedInput).toBeDefined()
      },
      { timeout: 2000 }
    )
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test assertion: narrow the captured `unknown` to read the payload
    const payload = (capturedInput as { readonly payload: Record<string, unknown> }).payload
    expect(payload['device_name']).toBe('Ada')
    expect(payload['scope']).toBeUndefined()
  })

  test('renders the failure view when device authorization errors', async () => {
    layerHolder.current = makeClientLayer({
      DeviceAuthorization: () => Effect.fail(new Error('device endpoint exploded')),
      TokenExchange: () => PENDING_FOREVER,
    })

    render(withTokenStore(<NeedsAuthMessage />))
    await startSignIn()

    await waitFor(
      () => {
        expect(screen.getByText('Sign-in failed')).toBeTruthy()
      },
      { timeout: 2000 }
    )
    expect(screen.getByText('device endpoint exploded')).toBeTruthy()
  })

  test('writes the issued token and navigates to the default path once exchange resolves', async () => {
    // jsdom's `location.assign` isn't spy-able (non-configurable), so swap
    // the whole `location` for a stub exposing just what the flow reads.
    const assignMock = vi.fn<(url: string) => void>()
    const realLocation = window.location
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { search: '', assign: assignMock },
    })
    try {
      layerHolder.current = makeClientLayer({
        DeviceAuthorization: () => Effect.succeed(DEVICE_AUTH_RESPONSE),
        TokenExchange: () => Effect.succeed({ access_token: 'issued-token', expires_in: 3600 }),
      })

      render(withTokenStore(<NeedsAuthMessage />))
      await startSignIn()

      // The web store ignores the passed signal and re-derives from the cookie,
      // but the value NeedsAuthMessage publishes is the honest `AuthedUntil` the
      // sign-in just achieved.
      await waitFor(
        () => {
          expect(setAuthStateMock).toHaveBeenCalledTimes(1)
        },
        { timeout: 2000 }
      )
      expect(setAuthStateMock.mock.calls[0]?.[0]?._tag).toBe('AuthedUntil')
      // No `?returnTo=` in the stub location, so sign-in lands on the default.
      expect(assignMock).toHaveBeenCalledWith('/home')
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: realLocation })
    }
  })
})

describe('sanitizeReturnTo', () => {
  // Open-redirect guard: every same-origin absolute path is preserved
  // verbatim, and anything a browser would resolve to a different origin
  // (or that lacks a usable value) collapses to the default landing path.
  for (const [raw, expected] of [
    [null, '/home'],
    ['', '/home'],
    ['/dashboard', '/dashboard'],
    ['/patients/123?tab=meds#vitals', '/patients/123?tab=meds#vitals'],
    ['//evil.com', '/home'],
    ['/\\evil.com', '/home'],
    ['https://evil.com/phish', '/home'],
    ['javascript:alert(1)', '/home'],
    ['relative/path', '/home'],
  ] as const) {
    test(`maps ${JSON.stringify(raw)} to ${expected}`, () => {
      expect(sanitizeReturnTo(raw)).toBe(expected)
    })
  }

  test('output is always a same-origin absolute path (no open redirect)', () => {
    fc.assert(
      fc.property(fc.option(fc.string(), { nil: null }), (raw) => {
        const result = sanitizeReturnTo(raw)
        // A leading single `/` (and never `//` or `/\`) is exactly what a
        // browser resolves against the current origin — so the result can
        // never escape to an attacker-controlled host.
        expect(result.startsWith('/')).toBe(true)
        expect(result.startsWith('//')).toBe(false)
        expect(result.startsWith('/\\')).toBe(false)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
