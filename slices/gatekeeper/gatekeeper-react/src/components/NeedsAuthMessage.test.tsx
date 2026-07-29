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
 * setup form (device name + scope picker), and only on "Request access" runs the
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

// Stands in for the host-threaded `firstPartyClientId` router-context value.
// `undefined` (the default) exercises the standalone `FIRST_PARTY_CLIENT_ID`
// fallback; a set value proves the device-login request forwards the injected id.
const clientIdHolder: { current: string | undefined } = { current: undefined }

vi.mock('../router-context.ts', () => ({
  useGatekeeperRuntimeLayer: (): Layer.Layer<GatekeeperHttpApiClient> => layerHolder.current,
  useGatekeeperLocalGrantedScopes: (): string | undefined => scopesHolder.current,
  useGatekeeperFirstPartyClientId: (): string | undefined => clientIdHolder.current,
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
  clientIdHolder.current = undefined
})

/** The canned RFC 8628 §3.2 device-authorization response the stubs return. */
const DEVICE_AUTH_RESPONSE = {
  user_code: 'WDJB-MJHT',
  device_code: 'dev-1',
  verification_uri: 'https://example.com/device',
  verification_uri_complete: 'https://example.com/device?code=WDJB-MJHT',
  interval: 5,
}

/** Click the form's "Request access" button to launch the flow. */
const startSignIn = async (): Promise<void> => {
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Request access' }))
}

/**
 * Run `body` with `window.location` swapped for a stub exposing just the
 * `search` the screen reads and a spy-able `assign` — jsdom's real `location` is
 * non-configurable, so neither can be set directly. The step-up path is driven
 * entirely through `?requestScopes=` / `?returnTo=`, so this is how those tests
 * put the screen in the state a 403 navigation leaves it in.
 */
const withLocation = async (
  search: string,
  body: (assign: ReturnType<typeof vi.fn<(url: string) => void>>) => Promise<void>
): Promise<void> => {
  const assignMock = vi.fn<(url: string) => void>()
  const realLocation = window.location
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { search, assign: assignMock },
  })
  try {
    await body(assignMock)
  } finally {
    Object.defineProperty(window, 'location', { configurable: true, value: realLocation })
  }
}

/** The `scope` string the stubbed device-authorization call received, as a set. */
const capturedScopes = (capturedInput: unknown): ReadonlySet<string> => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test assertion: narrow the captured `unknown` to read the payload
  const payload = (capturedInput as { readonly payload: Record<string, unknown> }).payload
  const scope = payload['scope']
  return new Set(typeof scope === 'string' ? scope.split(' ').filter(Boolean) : [])
}

describe('<NeedsAuthMessage> device flow', () => {
  test('shows the setup form on landing and fires no I/O until "Request access"', () => {
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
    expect(screen.getByText('Set up temporary device access')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Request access' })).toBeTruthy()
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

  test('forwards the typed device name and the seeded read+search preset scopes', async () => {
    // The picker seeds the read+search happy path (all records, all patients, plus
    // Wildflower admin), so an untouched form requests exactly that; the typed
    // name rides along.
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
    await user.click(screen.getByRole('button', { name: 'Request access' }))

    await waitFor(
      () => {
        expect(capturedInput).toBeDefined()
      },
      { timeout: 2000 }
    )
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test assertion: narrow the captured `unknown` to read the payload
    const payload = (capturedInput as { readonly payload: Record<string, unknown> }).payload
    expect(payload['device_name']).toBe('Ada')
    expect(payload['scope']).toBe('system/*.rs wildflower/*.rs')
    // No host-threaded id → the standalone `FIRST_PARTY_CLIENT_ID` fallback.
    expect(payload['client_id']).toBe('wildflower-host')
  })

  test('identifies the request with the host-threaded first-party client id', async () => {
    // The live Tauri app threads the id from `tauri-shared-config.json`; the
    // request must carry that value, not the standalone fallback — so the id
    // gatekeeper-rust seeds and the id the WebView presents derive from one
    // source and can't drift. A regression to a hardcoded literal fails this.
    clientIdHolder.current = 'wildflower-host-from-config'
    let capturedInput: unknown
    layerHolder.current = makeClientLayer({
      DeviceAuthorization: (input) => {
        capturedInput = input
        return Effect.succeed(DEVICE_AUTH_RESPONSE)
      },
      TokenExchange: () => PENDING_FOREVER,
    })

    render(withTokenStore(<NeedsAuthMessage />))
    await startSignIn()

    await waitFor(
      () => {
        expect(capturedInput).toBeDefined()
      },
      { timeout: 2000 }
    )
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test assertion: narrow the captured `unknown` to read the payload
    const payload = (capturedInput as { readonly payload: Record<string, unknown> }).payload
    expect(payload['client_id']).toBe('wildflower-host-from-config')
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
    layerHolder.current = makeClientLayer({
      DeviceAuthorization: () => Effect.succeed(DEVICE_AUTH_RESPONSE),
      TokenExchange: () => Effect.succeed({ access_token: 'issued-token', expires_in: 3600 }),
    })

    await withLocation('', async (assignMock) => {
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
    })
  })
})

/**
 * The 403 step-up path (resource-authorization epic child ⑤). A denied action
 * navigates here with `?requestScopes=` (what the 403 said was missing) and
 * `?returnTo=` (where the denial happened); the screen must pre-fill the request
 * with those scopes and land the user back where they were once the grant is
 * issued, so the original action re-runs.
 */
describe('<NeedsAuthMessage> step-up pre-fill', () => {
  test('requests the pre-filled scopes alongside the preset, not instead of it', async () => {
    // The device flow mints a *whole new grant*, so requesting only the missing
    // scope would strip the read+search access the session already had — the
    // union is what keeps stepping up from being a downgrade.
    let capturedInput: unknown
    layerHolder.current = makeClientLayer({
      DeviceAuthorization: (input) => {
        capturedInput = input
        return Effect.succeed(DEVICE_AUTH_RESPONSE)
      },
      TokenExchange: () => PENDING_FOREVER,
    })

    await withLocation('?requestScopes=wildflower%2FGrant.d', async () => {
      render(withTokenStore(<NeedsAuthMessage />))
      await startSignIn()

      await waitFor(
        () => {
          expect(capturedInput).toBeDefined()
        },
        { timeout: 2000 }
      )
      const scopes = capturedScopes(capturedInput)
      expect(scopes.has('wildflower/Grant.d')).toBe(true)
      expect(scopes.has('system/*.rs')).toBe(true)
      expect(scopes.has('wildflower/*.rs')).toBe(true)
    })
  })

  test('names a scope the client may not request instead of requesting it', async () => {
    // `/oauth/device_authorization` rejects the *whole* request with
    // `invalid_scope` if any scope falls outside the client's allowed set, so an
    // out-of-envelope scope must stay out of the payload — but the user is told
    // about it rather than watching it silently vanish.
    scopesHolder.current = 'wildflower/*.cruds'
    let capturedInput: unknown
    layerHolder.current = makeClientLayer({
      DeviceAuthorization: (input) => {
        capturedInput = input
        return Effect.succeed(DEVICE_AUTH_RESPONSE)
      },
      TokenExchange: () => PENDING_FOREVER,
    })

    await withLocation(
      '?requestScopes=wildflower%2FGrant.d%20patient%2FObservation.r',
      async () => {
        render(withTokenStore(<NeedsAuthMessage />))
        expect(screen.getByText('patient/Observation.r')).toBeTruthy()
        await startSignIn()

        await waitFor(
          () => {
            expect(capturedInput).toBeDefined()
          },
          { timeout: 2000 }
        )
        const scopes = capturedScopes(capturedInput)
        expect(scopes.has('wildflower/Grant.d')).toBe(true)
        expect(scopes.has('patient/Observation.r')).toBe(false)
      }
    )
  })

  test('names a scope the grammar does not recognise instead of requesting it', async () => {
    // The clamp folds only the resource partitions and the flags, so a scope no
    // scope grammar parses (a resource type this build doesn't know, or a crafted
    // `?requestScopes=`) would otherwise pass it, ride into the payload
    // *invisibly* — the picker renders only the envelope's own unknowns, so there
    // is no control to prune it with — and make the server reject the whole
    // request with `invalid_scope`.
    let capturedInput: unknown
    layerHolder.current = makeClientLayer({
      DeviceAuthorization: (input) => {
        capturedInput = input
        return Effect.succeed(DEVICE_AUTH_RESPONSE)
      },
      TokenExchange: () => PENDING_FOREVER,
    })

    await withLocation('?requestScopes=wildflower%2FGrant.d%20not-a-scope', async () => {
      render(withTokenStore(<NeedsAuthMessage />))
      expect(screen.getByText('not-a-scope')).toBeTruthy()
      await startSignIn()

      await waitFor(
        () => {
          expect(capturedInput).toBeDefined()
        },
        { timeout: 2000 }
      )
      const scopes = capturedScopes(capturedInput)
      expect(scopes.has('wildflower/Grant.d')).toBe(true)
      expect(scopes.has('not-a-scope')).toBe(false)
    })
  })

  test('leaves the preset seed alone when no scopes were pre-filled', async () => {
    // The undeclared-403 / plain-sign-in shape: an absent `requestScopes` must not
    // narrow the request to nothing.
    let capturedInput: unknown
    layerHolder.current = makeClientLayer({
      DeviceAuthorization: (input) => {
        capturedInput = input
        return Effect.succeed(DEVICE_AUTH_RESPONSE)
      },
      TokenExchange: () => PENDING_FOREVER,
    })

    await withLocation('?returnTo=%2Fsettings', async () => {
      render(withTokenStore(<NeedsAuthMessage />))
      await startSignIn()

      await waitFor(
        () => {
          expect(capturedInput).toBeDefined()
        },
        { timeout: 2000 }
      )
      expect([...capturedScopes(capturedInput)].toSorted()).toEqual([
        'system/*.rs',
        'wildflower/*.rs',
      ])
    })
  })

  test('returns to where the denial happened once the grant is issued', async () => {
    // This is the "retry the original action" leg: the full page load re-boots the
    // app on the original route with a cold query cache, so its loader re-runs the
    // denied call against the new grant.
    layerHolder.current = makeClientLayer({
      DeviceAuthorization: () => Effect.succeed(DEVICE_AUTH_RESPONSE),
      TokenExchange: () => Effect.succeed({ access_token: 'issued-token', expires_in: 3600 }),
    })

    await withLocation(
      '?returnTo=%2Fsettings%2Fdatabases&requestScopes=wildflower%2FGrant.d',
      async (assignMock) => {
        render(withTokenStore(<NeedsAuthMessage />))
        await startSignIn()

        await waitFor(
          () => {
            expect(assignMock).toHaveBeenCalledWith('/settings/databases')
          },
          { timeout: 2000 }
        )
      }
    )
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
