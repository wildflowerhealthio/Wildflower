import { HttpClient, HttpClientResponse } from '@effect/platform'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Effect, Layer, pipe, SubscriptionRef } from 'effect'
import { BearerToken } from 'kitchen-sink/auth-token'
import type { TunnelAdminHttpApiClient } from 'tunnel-core/clients'
import { Tunnel } from 'tunnel-core/http-api-definition'
import { afterEach, describe, expect, test } from 'vite-plus/test'

import { TUNNEL_STATE_QUERY_KEY, type RunAuthed, type TunnelState } from './queries.ts'
import { sliceRuntimeLayer, type RouterContext } from './router-context.ts'
import { routeTree } from './routeTree.gen.ts'

// The fresh-install snapshot the cache (and the stub server's GET) starts at.
const INITIAL: TunnelState = Tunnel.freshTunnelState

// A snapshot with a configured relay (non-secret fields returned; token never).
const CONFIGURED: TunnelState = {
  ...INITIAL,
  settingsRevision: 3,
  publicHost: 'clinic.example.com',
  relay: {
    remoteAddr: 'relay.example.com:2333',
    publicKey: 'base64key',
    serviceName: 'wildflower',
  },
}

const jsonResponse = (status: number, body: TunnelState): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

/**
 * Stateful stub server: GET returns the current snapshot; the FIRST PUT
 * 409s (simulating a concurrent writer that already advanced the server to
 * `revision 1` / `other.example.com`), and every later PUT applies and
 * bumps the revision. Keeping GET consistent with the adopted snapshot
 * means the mutation's `onSettled` refetch doesn't undo the 409 rebase.
 */
const makeConflictThenApplyHttp = (): Layer.Layer<HttpClient.HttpClient> => {
  let serverState: TunnelState = INITIAL
  let putCount = 0
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      if (request.method !== 'PUT') {
        return Effect.succeed(HttpClientResponse.fromWeb(request, jsonResponse(200, serverState)))
      }
      putCount += 1
      if (putCount === 1) {
        serverState = { ...INITIAL, settingsRevision: 1, publicHost: 'other.example.com' }
        return Effect.succeed(HttpClientResponse.fromWeb(request, jsonResponse(409, serverState)))
      }
      serverState = { ...serverState, settingsRevision: serverState.settingsRevision + 1 }
      return Effect.succeed(HttpClientResponse.fromWeb(request, jsonResponse(200, serverState)))
    })
  )
}

/**
 * GET serves CONFIGURED; the FIRST PUT 409s with a newer revision but the
 * SAME relay view — a concurrent writer that bumped the revision without
 * touching the relay. The user's in-progress relay edit must survive it.
 */
const makeRelayConflictHttp = (): Layer.Layer<HttpClient.HttpClient> => {
  let serverState: TunnelState = CONFIGURED
  let conflicted = false
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      if (request.method !== 'PUT') {
        return Effect.succeed(HttpClientResponse.fromWeb(request, jsonResponse(200, serverState)))
      }
      if (!conflicted) {
        conflicted = true
        serverState = { ...CONFIGURED, settingsRevision: CONFIGURED.settingsRevision + 1 }
        return Effect.succeed(HttpClientResponse.fromWeb(request, jsonResponse(409, serverState)))
      }
      serverState = { ...serverState, settingsRevision: serverState.settingsRevision + 1 }
      return Effect.succeed(HttpClientResponse.fromWeb(request, jsonResponse(200, serverState)))
    })
  )
}

/** A server that only ever serves a fixed snapshot (no writes expected). */
const makeReadOnlyHttp = (snapshot: TunnelState = INITIAL): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, jsonResponse(200, snapshot)))
    )
  )

// Mirrors the app's `buildRunAuthed`; kept local so the slice stays
// app-independent (same shape as queries.test.ts / routes.test.tsx).
const makeRunAuthed = (httpLayer: Layer.Layer<HttpClient.HttpClient>): RunAuthed => {
  const tokenRef = Effect.runSync(SubscriptionRef.make<string | null>('token'))
  return <A, E>(
    effect: Effect.Effect<A, E, BearerToken | HttpClient.HttpClient | TunnelAdminHttpApiClient>
  ): Promise<A> =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(
          pipe(
            sliceRuntimeLayer,
            Layer.provideMerge(httpLayer),
            Layer.provideMerge(Layer.succeed(BearerToken, tokenRef))
          )
        ),
        Effect.scoped
      )
    )
}

const renderTunnelRoute = (
  httpLayer: Layer.Layer<HttpClient.HttpClient>,
  seedState: TunnelState = INITIAL
): QueryClient => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // Warm the cache so the route renders without suspending; the stub GET
  // still backs the `onSettled` refetch.
  queryClient.setQueryData<TunnelState>(TUNNEL_STATE_QUERY_KEY, seedState)
  const context: RouterContext = {
    queryClient,
    runAuthed: makeRunAuthed(httpLayer),
    runtimeLayer: Layer.die('runtimeLayer not used in this test'),
    awaitAuthReady: () => Promise.resolve(),
  }
  const router = createRouter({
    routeTree,
    context,
    // The form lives on the Relay settings detail page; the overview is
    // form-less. Tests that exercise host/relay edits + Save mount the
    // /relay route.
    history: createMemoryHistory({ initialEntries: ['/settings/tunnel/relay'] }),
  })
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
  return queryClient
}

const asInput = (el: HTMLElement): HTMLInputElement => {
  if (!(el instanceof HTMLInputElement)) throw new Error('expected an <input> element')
  return el
}

const saveButton = (): HTMLButtonElement => {
  const button = screen.getByRole('button', { name: 'Save' })
  if (!(button instanceof HTMLButtonElement)) throw new Error('expected a <button>')
  return button
}

afterEach(() => {
  cleanup()
})

describe('tunnel settings form — conflict flow', () => {
  test('on a 409 the host input re-syncs to the adopted snapshot and the banner shows', async () => {
    renderTunnelRoute(makeConflictThenApplyHttp())

    const host = asInput(await screen.findByLabelText('Public host'))
    fireEvent.change(host, { target: { value: 'mine.example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    // The adopted 409 snapshot replaces the stale edit — the input now
    // truthfully shows the other writer's value, so a blind re-Save can't
    // clobber it.
    await waitFor(() => {
      expect(asInput(screen.getByLabelText('Public host')).value).toBe('other.example.com')
    })
    expect(screen.getByText(/changed elsewhere/i)).toBeDefined()
  })

  // Note: the prior "conflict banner persists across an unrelated toggle"
  // case exercised cross-screen state — toggling on the Tunnel overview
  // while the host conflict was live on the (then-shared) form. The form
  // now lives only on the Relay settings screen and uses its own
  // `useTunnelSettingsForm` instance, so a toggle from another screen
  // doesn't share the form's conflict flag. The flag's per-instance
  // behavior is covered by `use-field-draft.test.ts`.

  test('editing the host dismisses the conflict banner', async () => {
    renderTunnelRoute(makeConflictThenApplyHttp())

    const host = asInput(await screen.findByLabelText('Public host'))
    fireEvent.change(host, { target: { value: 'mine.example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText(/changed elsewhere/i)

    fireEvent.change(screen.getByLabelText('Public host'), {
      target: { value: 'mine-again.example.com' },
    })
    expect(screen.queryByText(/changed elsewhere/i)).toBeNull()
  })
})

describe('tunnel settings form — relay', () => {
  test('dirtying a relay field without a token surfaces an error and disables Save', async () => {
    renderTunnelRoute(makeReadOnlyHttp())

    await screen.findByLabelText('Public host')
    // Type into one relay field but supply no token.
    fireEvent.change(screen.getByLabelText('Relay address'), {
      target: { value: 'relay.example.com:2333' },
    })

    expect(screen.getByText(/including a new token/i)).toBeDefined()
    expect(saveButton().disabled).toBe(true)
  })

  test('a configured relay prefills the visible fields with a blank token', async () => {
    renderTunnelRoute(makeReadOnlyHttp(CONFIGURED), CONFIGURED)

    expect(asInput(await screen.findByLabelText('Relay address')).value).toBe(
      'relay.example.com:2333'
    )
    expect(asInput(screen.getByLabelText('Service name')).value).toBe('wildflower')
    expect(asInput(screen.getByLabelText('Public key')).value).toBe('base64key')
    // The write-only token is never prefilled.
    expect(asInput(screen.getByLabelText('Token')).value).toBe('')
    // Nothing dirty (host matches, relay untouched) → Save disabled.
    expect(saveButton().disabled).toBe(true)
  })

  test('changing a prefilled relay field requires a fresh token before Save enables', async () => {
    renderTunnelRoute(makeReadOnlyHttp(CONFIGURED), CONFIGURED)

    const addr = asInput(await screen.findByLabelText('Relay address'))
    fireEvent.change(addr, { target: { value: 'new-relay.example.com:2333' } })
    // A relay change with no token is invalid.
    expect(screen.getByText(/including a new token/i)).toBeDefined()
    expect(saveButton().disabled).toBe(true)

    // Supplying a fresh token completes the (all-or-nothing) relay change.
    fireEvent.change(asInput(screen.getByLabelText('Token')), {
      target: { value: 'fresh-token' },
    })
    expect(screen.queryByText(/including a new token/i)).toBeNull()
    expect(saveButton().disabled).toBe(false)
  })
})

describe('tunnel settings form — dirty-edit preservation', () => {
  // Note: the prior "unsaved host edit survives an unrelated toggle"
  // case exercised cross-screen state — the toggle was an unrelated
  // mutation rebasing the form's snapshot. The toggle now lives on the
  // Tunnel overview while the form lives on the Relay settings screen,
  // so the cross-screen rebase isn't reachable from a single mounted
  // route. The underlying property (a dirty draft survives an unrelated
  // revision bump that left the field's baseline alone) is covered at
  // the unit level in `use-field-draft.test.ts`.

  test('a dirty relay change (incl. token) survives a 409 and stays sendable', async () => {
    renderTunnelRoute(makeRelayConflictHttp(), CONFIGURED)

    fireEvent.change(asInput(await screen.findByLabelText('Relay address')), {
      target: { value: 'new-relay.example.com:2333' },
    })
    fireEvent.change(asInput(screen.getByLabelText('Token')), {
      target: { value: 'fresh-token' },
    })
    fireEvent.click(saveButton())

    // The 409 raises the banner, but the relay view didn't change server-side,
    // so the typed reconfiguration (incl. the write-only token) must be kept —
    // a re-Save still carries it instead of silently applying host-only.
    await screen.findByText(/changed elsewhere/i)
    expect(asInput(screen.getByLabelText('Relay address')).value).toBe('new-relay.example.com:2333')
    expect(asInput(screen.getByLabelText('Token')).value).toBe('fresh-token')
    expect(saveButton().disabled).toBe(false)
  })
})
