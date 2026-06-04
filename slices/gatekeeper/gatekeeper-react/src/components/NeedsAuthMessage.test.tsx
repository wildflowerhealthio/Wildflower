import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { Effect, Layer, SubscriptionRef } from 'effect'
import fc from 'fast-check'
import { GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import { numRunsFor } from 'kitchen-sink/test'
import type { JSX, ReactNode } from 'react'
import { AuthTokenProvider, type AuthTokenStore } from 'react-kitchen-sink'
import { afterEach, describe, expect, test, vi } from 'vite-plus/test'

/**
 * Pins the `NeedsAuthMessage` stream/fiber consumer: it runs the RFC 8628
 * device-authorization flow against the composed runtime layer and walks
 * the `DeviceFlowState` machine as the gatekeeper client resolves. A
 * regression in how the screen forks the flow, reads the
 * `DeviceAuthorization` response, or maps a thrown error to a terminal
 * state would otherwise go uncaught.
 *
 * The runtime layer is mocked to a stubbed `GatekeeperHttpApiClient`, so
 * the flow runs end-to-end with no HTTP — only the device-authorization
 * leg is exercised (the token-exchange leg never resolves in these
 * stubs, which is fine: the assertions target the `pending`/`error`
 * states the flow reaches first).
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

vi.mock('../router-context.ts', () => ({
  useGatekeeperRuntimeLayer: (): Layer.Layer<GatekeeperHttpApiClient> => layerHolder.current,
}))

// The device flow writes the issued token through the
// `AuthTokenStore.setToken` it pulled from the surrounding
// `<AuthTokenProvider>` (via `useAuthTokenSetter`). Tests wrap the
// rendered subject in `withTokenStore(...)` so the assertions can
// observe the write through `setTokenMock` without poking
// `token-storage` directly.
const setTokenMock = vi.fn<(token: string | null) => void>()
const tokenRef = Effect.runSync(SubscriptionRef.make<string | null>(null))
const testTokenStore: AuthTokenStore = {
  subscribable: tokenRef,
  setToken: (token) => setTokenMock(token),
}
const withTokenStore = (children: ReactNode): JSX.Element => (
  <AuthTokenProvider store={testTokenStore}>{children}</AuthTokenProvider>
)

const { NeedsAuthMessage, sanitizeReturnTo } = await import('./NeedsAuthMessage.tsx')

const PENDING_FOREVER = Effect.never

afterEach(() => {
  cleanup()
  setTokenMock.mockReset()
})

describe('<NeedsAuthMessage> device flow', () => {
  test('shows the starting message before any I/O resolves', () => {
    layerHolder.current = makeClientLayer({
      DeviceAuthorization: () => PENDING_FOREVER,
      TokenExchange: () => PENDING_FOREVER,
    })

    render(withTokenStore(<NeedsAuthMessage />))

    // The mount debounce gates I/O, so the first paint is the spinner copy.
    expect(screen.getByText('Starting sign-in…')).toBeTruthy()
  })

  test('surfaces the user_code once device authorization resolves', async () => {
    layerHolder.current = makeClientLayer({
      DeviceAuthorization: () =>
        Effect.succeed({
          user_code: 'WDJB-MJHT',
          device_code: 'dev-1',
          verification_uri: 'https://example.com/device',
          verification_uri_complete: 'https://example.com/device?code=WDJB-MJHT',
          interval: 5,
        }),
      // Never resolves: the flow parks in the `pending` state showing the code.
      TokenExchange: () => PENDING_FOREVER,
    })

    render(withTokenStore(<NeedsAuthMessage />))

    await waitFor(
      () => {
        expect(screen.getByText('WDJB-MJHT')).toBeTruthy()
      },
      { timeout: 2000 }
    )
    expect(screen.getByText('Sign in on another device')).toBeTruthy()
  })

  test('renders the failure view when device authorization errors', async () => {
    layerHolder.current = makeClientLayer({
      DeviceAuthorization: () => Effect.fail(new Error('device endpoint exploded')),
      TokenExchange: () => PENDING_FOREVER,
    })

    render(withTokenStore(<NeedsAuthMessage />))

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
        DeviceAuthorization: () =>
          Effect.succeed({
            user_code: 'WDJB-MJHT',
            device_code: 'dev-1',
            verification_uri: 'https://example.com/device',
            verification_uri_complete: 'https://example.com/device?code=WDJB-MJHT',
            interval: 5,
          }),
        TokenExchange: () => Effect.succeed({ access_token: 'issued-token' }),
      })

      render(withTokenStore(<NeedsAuthMessage />))

      await waitFor(
        () => {
          expect(setTokenMock).toHaveBeenCalledWith('issued-token')
        },
        { timeout: 2000 }
      )
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
