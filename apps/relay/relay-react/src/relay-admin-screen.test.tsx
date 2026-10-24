import { HttpClient, HttpClientResponse, type HttpClientRequest } from '@effect/platform'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { RelayAdminHttpApiClient } from '@wildflowerhealthio/relay-core-js/clients'
import { Tunnels } from '@wildflowerhealthio/relay-core-js/http-api-definition'
import { AdminKeyStore, importAdminKey } from '@wildflowerhealthio/relay-core-js/key-store'
import { Effect, Layer, ManagedRuntime, Option, Schema } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'

import { KEY_REFUSED_MESSAGE } from './admin-key-form.tsx'
import type { RelayAdminRuntime } from './relay-admin-context.ts'
import { RelayAdminProvider } from './relay-admin-provider.tsx'
import { RelayAdminScreen } from './relay-admin-screen.tsx'

/**
 * The whole screen, through the real hooks and the real `RelayAdminApi`
 * client, against an in-memory relay that answers as
 * `apps/relay/relay-server/src/site/admin.rs` does. The signing `HttpClient` is
 * left out (`relay-core-js` tests it against the relay's verifier); the key
 * store is the in-memory one.
 */

const ADMIN_KEY = 'an-admin-key-of-thirty-two-bytes'
const DOMAIN = 'relay.example.com'

interface StoredTunnel {
  readonly email: string
  readonly created_at: number
  readonly last_outcome: typeof Tunnels.TunnelOutcome.Type | null
}

/** One hour of `GET /api/connection-totals`, as the relay sends it. */
type HourTotals = typeof Tunnels.ConnectionTotalsSchema.Encoded

/**
 * The relay's tunnels, its connection totals and what it was asked; `refuse`
 * answers every call `401`.
 */
interface FakeRelay {
  readonly tunnels: Map<string, StoredTunnel>
  totals: readonly HourTotals[]
  readonly requests: string[]
  refuse: boolean
}

const text = (status: number, body: string): Response =>
  new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } })

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const decodeCreateBody = Schema.decodeUnknownSync(Schema.parseJson(Tunnels.CreateTunnelBodySchema))

/** The relay's answer to `request`, changing `relay` as the admin API does. */
const answer = (
  relay: FakeRelay,
  request: HttpClientRequest.HttpClientRequest,
  url: URL
): Response => {
  relay.requests.push(`${request.method} ${url.pathname}`)
  if (relay.refuse) return new Response(null, { status: 401 })
  const name = url.pathname.match(/^\/api\/tunnels\/([^/]+)$/)?.[1]
  if (request.method === 'GET' && url.pathname === '/api/tunnels') {
    return json(
      200,
      [...relay.tunnels].map(([tunnelName, tunnel]) => ({
        name: tunnelName,
        email: tunnel.email,
        public_host: `${tunnelName}.${DOMAIN}`,
        created_at: tunnel.created_at,
        last_outcome: tunnel.last_outcome,
      }))
    )
  }
  if (request.method === 'GET' && url.pathname === '/api/connection-totals') {
    return json(200, relay.totals)
  }
  if (request.method === 'POST' && url.pathname === '/api/tunnels') {
    const { email, name: chosen } = decodeCreateBody(
      request.body._tag === 'Uint8Array' ? new TextDecoder().decode(request.body.body) : ''
    )
    const tunnelName = chosen ?? 'calm-otter'
    if (tunnelName === 'admin') return text(409, 'the name is reserved')
    if (relay.tunnels.has(tunnelName)) return text(409, 'a tunnel already has the name')
    relay.tunnels.set(tunnelName, { email, created_at: 1_700_000_000, last_outcome: null })
    return json(201, {
      name: tunnelName,
      token: `token-for-${tunnelName}`,
      public_host: `${tunnelName}.${DOMAIN}`,
    })
  }
  const claimCodesFor = url.pathname.match(/^\/api\/tunnels\/([^/]+)\/claim-codes$/)?.[1]
  if (request.method === 'POST' && claimCodesFor !== undefined) {
    if (!relay.tunnels.has(claimCodesFor)) return text(404, 'no tunnel has the name')
    return json(201, { code: 'ABCD-EFGH', expires_at: 1_700_000_900 })
  }
  if (request.method === 'POST' && url.pathname === '/api/claim-codes') {
    return json(201, { code: 'JKMN-PQRS', expires_at: 1_700_000_900 })
  }
  const tokenFor = url.pathname.match(/^\/api\/tunnels\/([^/]+)\/token$/)?.[1]
  if (request.method === 'POST' && tokenFor !== undefined) {
    if (!relay.tunnels.has(tokenFor)) return text(404, 'no tunnel has the name')
    return json(200, {
      name: tokenFor,
      token: `new-token-for-${tokenFor}`,
      public_host: `${tokenFor}.${DOMAIN}`,
    })
  }
  if (request.method === 'DELETE' && name !== undefined) {
    return relay.tunnels.delete(name)
      ? new Response(null, { status: 204 })
      : text(404, 'no tunnel has the name')
  }
  return new Response(null, { status: 404 })
}

/** A runtime over `relay`, with the admin key stored when `signedIn`. */
const runtimeFor = async (relay: FakeRelay, signedIn: boolean): Promise<RelayAdminRuntime> => {
  const transport = HttpClient.make((request, url) =>
    Effect.sync(() => HttpClientResponse.fromWeb(request, answer(relay, request, url)))
  )
  const runtime = ManagedRuntime.make(
    RelayAdminHttpApiClient.layer.pipe(
      Layer.provide(Layer.succeed(HttpClient.HttpClient, transport)),
      Layer.provideMerge(AdminKeyStore.layerMemory)
    )
  )
  if (signedIn) {
    const key = await Effect.runPromise(importAdminKey(ADMIN_KEY))
    await runtime.runPromise(Effect.flatMap(AdminKeyStore, (store) => store.save(key)))
  }
  return runtime
}

/** Whether `runtime`'s store holds a key. */
const holdsKey = (runtime: RelayAdminRuntime): Promise<boolean> =>
  runtime.runPromise(Effect.flatMap(AdminKeyStore, (store) => store.load)).then(Option.isSome)

const renderScreen = (runtime: RelayAdminRuntime): QueryClient => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <RelayAdminProvider runtime={runtime}>
        <RelayAdminScreen host={`admin.${DOMAIN}`} />
      </RelayAdminProvider>
    </QueryClientProvider>
  )
  return queryClient
}

const relayWith = (names: readonly string[]): FakeRelay => ({
  tunnels: new Map(
    names.map((name) => [
      name,
      { email: `${name}@example.com`, created_at: 1_700_000_000, last_outcome: null },
    ])
  ),
  totals: [],
  requests: [],
  refuse: false,
})

/** An hour of totals starting at `hour` (Unix seconds), zero but for `counts`. */
const hourTotals = (hour: number, counts: Partial<Omit<HourTotals, 'hour'>>): HourTotals => ({
  hour,
  ok: 0,
  over_connection_limit: 0,
  hello_timeout: 0,
  not_a_hello: 0,
  no_server_name: 0,
  unknown_tunnel: 0,
  tunnel_down: 0,
  tunnel_busy: 0,
  tunnel_closed: 0,
  proxy_header_failed: 0,
  ...counts,
})

/** The text of each cell of each row of `table`, header row first. */
const cellsOf = (table: HTMLElement): string[][] =>
  within(table)
    .getAllByRole('row')
    .map((row) => [...row.querySelectorAll('th, td')].map((cell) => cell.textContent ?? ''))

// jsdom has no native `<dialog>`; model `showModal`/`close` as the `open`
// attribute and a `close` event, as react-tundraish's own tests do.
const dialogMethods = ['showModal', 'close'] as const
const originalDialogMethods = dialogMethods.map((method) =>
  Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, method)
)

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal(): void {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close = function close(): void {
    this.removeAttribute('open')
    this.dispatchEvent(new Event('close'))
  }
})

afterEach(() => {
  cleanup()
  dialogMethods.forEach((method, index) => {
    const descriptor = originalDialogMethods[index]
    if (descriptor === undefined) Reflect.deleteProperty(HTMLDialogElement.prototype, method)
    else Object.defineProperty(HTMLDialogElement.prototype, method, descriptor)
  })
})

describe('RelayAdminScreen', () => {
  it('lists every tunnel with its public host, email and creation date', async () => {
    // Arrange
    const relay = relayWith(['alice', 'bob'])

    // Act
    renderScreen(await runtimeFor(relay, true))

    // Assert
    const rows = await screen.findAllByRole('listitem')
    expect(rows).toHaveLength(2)
    const alice = within(rows[0])
    expect(alice.getByText('alice')).toBeDefined()
    expect(alice.getByText('alice.relay.example.com')).toBeDefined()
    expect(alice.getByText('alice@example.com')).toBeDefined()
    expect(alice.getByText('Created 2023-11-14')).toBeDefined()
  })

  it.each([
    ['ok', 'Last connection reached the device'],
    ['tunnel_down', 'Last connection refused: device offline'],
    ['tunnel_busy', 'Last connection refused: device not taking connections'],
    ['tunnel_closed', 'Last connection refused: closed by the tunnel'],
    ['proxy_header_failed', 'Last connection refused: relay error'],
    [null, 'No connections since the relay started'],
  ] as const)('shows a last outcome of %s as “%s”', async (lastOutcome, words) => {
    // Arrange
    const relay = relayWith([])
    relay.tunnels.set('alice', {
      email: 'alice@example.com',
      created_at: 1_700_000_000,
      last_outcome: lastOutcome,
    })

    // Act
    renderScreen(await runtimeFor(relay, true))

    // Assert
    const [alice] = await screen.findAllByRole('listitem')
    expect(within(alice).getByText(words)).toBeDefined()
  })

  it('shows the last day by hour and the last 30 days by day, newest first', async () => {
    // Arrange
    const relay = relayWith(['alice'])
    const thisHour = Math.floor(Date.now() / 3_600_000) * 3600
    const today = Math.floor(Date.now() / 86_400_000) * 86_400
    const twoDaysAgo = today - 2 * 86_400
    relay.totals = [
      hourTotals(twoDaysAgo + 3600, { ok: 1, unknown_tunnel: 3 }),
      hourTotals(twoDaysAgo + 7200, { ok: 1, unknown_tunnel: 1 }),
      hourTotals(thisHour, { ok: 2, tunnel_down: 1 }),
    ]
    const isoDate = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 10)

    // Act
    renderScreen(await runtimeFor(relay, true))

    // Assert
    const hourly = await screen.findByRole('table', { name: 'Last 24 hours' })
    const hour = new Date(thisHour * 1000).toISOString()
    expect(cellsOf(hourly)).toEqual([
      ['Hour (UTC)', 'Reached device', 'Refused', 'Device offline'],
      [`${hour.slice(0, 10)} ${hour.slice(11, 13)}:00`, '2', '1', '1'],
    ])
    const daily = screen.getByRole('table', { name: 'Last 30 days' })
    expect(cellsOf(daily)).toEqual([
      ['Day (UTC)', 'Reached device', 'Refused', 'Unknown tunnel', 'Device offline'],
      [isoDate(thisHour), '2', '1', '0', '1'],
      [isoDate(twoDaysAgo), '2', '4', '4', '0'],
    ])
  })

  it('says so when there were no connections in the last 30 days', async () => {
    // Arrange
    const relay = relayWith(['alice'])

    // Act
    renderScreen(await runtimeFor(relay, true))

    // Assert
    expect(await screen.findByText('No connections in the last 30 days.')).toBeDefined()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('signs in with the pasted key, then reads the tunnels', async () => {
    // Arrange
    const relay = relayWith(['alice'])
    const runtime = await runtimeFor(relay, false)
    const queryClient = renderScreen(runtime)
    const user = userEvent.setup()

    // Act
    await user.type(await screen.findByLabelText('Admin key'), `  ${ADMIN_KEY}  `)
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    // Assert
    expect(await screen.findByText('alice.relay.example.com')).toBeDefined()
    expect(await holdsKey(runtime)).toBe(true)
    // The pasted text is not kept as the mutation's variables.
    await waitFor(() => {
      expect(queryClient.getMutationCache().getAll()).toEqual([])
    })
  })

  it('refuses to sign in with a key shorter than the relay accepts', async () => {
    // Arrange
    const runtime = await runtimeFor(relayWith([]), false)
    renderScreen(runtime)
    const user = userEvent.setup()

    // Act
    await user.type(await screen.findByLabelText('Admin key'), 'too-short')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    // Assert
    expect((await screen.findByRole('alert')).textContent).toContain('at least 32 bytes')
    expect(await holdsKey(runtime)).toBe(false)
  })

  it('shows a created tunnel’s token once, and not after Done', async () => {
    // Arrange
    const relay = relayWith([])
    const queryClient = renderScreen(await runtimeFor(relay, true))
    const user = userEvent.setup()
    await screen.findByText('No tunnels yet.')

    // Act
    await user.type(screen.getByLabelText('Owner’s email'), 'carol@example.com')
    await user.click(screen.getByRole('button', { name: 'Create tunnel' }))

    // Assert
    expect((await screen.findByLabelText('Token')).textContent).toBe('token-for-calm-otter')
    // It takes the form's place, at the form's heading level.
    expect(screen.getByRole('heading', { level: 2, name: 'Created calm-otter' })).toBeDefined()
    expect(screen.getByText(/won’t be shown again/)).toBeDefined()
    expect(relay.tunnels.get('calm-otter')?.email).toBe('carol@example.com')
    expect(await screen.findByText('calm-otter.relay.example.com')).toBeDefined()

    // Act
    await user.click(screen.getByRole('button', { name: 'Done' }))

    // Assert
    expect(screen.queryByText('token-for-calm-otter')).toBeNull()
    expect(screen.getByRole('button', { name: 'Create tunnel' })).toBeDefined()
    // Nor is it kept in the mutation cache.
    await waitFor(() => {
      expect(queryClient.getMutationCache().getAll()).toEqual([])
    })
  })

  it('shows the relay’s reason when the name is taken, and keeps the form', async () => {
    // Arrange
    const relay = relayWith(['alice'])
    renderScreen(await runtimeFor(relay, true))
    const user = userEvent.setup()
    await screen.findByText('alice.relay.example.com')

    // Act
    await user.type(screen.getByLabelText('Owner’s email'), 'mallory@example.com')
    await user.type(screen.getByLabelText('Name (optional)'), 'alice')
    await user.click(screen.getByRole('button', { name: 'Create tunnel' }))

    // Assert
    expect((await screen.findByRole('alert')).textContent).toContain(
      'a tunnel already has the name'
    )
    expect(relay.tunnels.get('alice')?.email).toBe('alice@example.com')
    expect(screen.queryByLabelText('Token')).toBeNull()
  })

  it('deletes a tunnel only once the dialog is confirmed', async () => {
    // Arrange
    const relay = relayWith(['alice', 'bob'])
    renderScreen(await runtimeFor(relay, true))
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Delete bob' }))
    const dialog = screen.getByRole('dialog')

    // Act
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    // Assert
    expect(relay.requests).not.toContain('DELETE /api/tunnels/bob')

    // Act
    await user.click(screen.getByRole('button', { name: 'Delete bob' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }))

    // Assert
    await waitFor(() => {
      expect(screen.queryByText('bob.relay.example.com')).toBeNull()
    })
    expect(relay.requests).toContain('DELETE /api/tunnels/bob')
    expect([...relay.tunnels.keys()]).toEqual(['alice'])
  })

  it('reissues a token only once confirmed, and shows the new one once', async () => {
    // Arrange
    const relay = relayWith(['alice', 'bob'])
    const queryClient = renderScreen(await runtimeFor(relay, true))
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Reissue token for bob' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/disconnects until it’s given the new one/)).toBeDefined()

    // Act
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    // Assert
    expect(relay.requests).not.toContain('POST /api/tunnels/bob/token')

    // Act
    await user.click(screen.getByRole('button', { name: 'Reissue token for bob' }))
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Reissue token' })
    )

    // Assert
    expect((await screen.findByLabelText('Token')).textContent).toBe('new-token-for-bob')
    expect(screen.getByRole('heading', { name: 'New token for bob' })).toBeDefined()
    expect(screen.getByText(/won’t be shown again/)).toBeDefined()
    expect(relay.requests).toContain('POST /api/tunnels/bob/token')

    // Act
    await user.click(screen.getByRole('button', { name: 'Done' }))

    // Assert
    expect(screen.queryByLabelText('Token')).toBeNull()
    await waitFor(() => {
      expect(queryClient.getMutationCache().getAll()).toEqual([])
    })
  })

  it('shows the relay’s reason when a reissued token’s tunnel is gone', async () => {
    // Arrange
    const relay = relayWith(['alice'])
    renderScreen(await runtimeFor(relay, true))
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Reissue token for alice' }))
    relay.tunnels.delete('alice')

    // Act
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Reissue token' })
    )

    // Assert
    expect((await screen.findByRole('alert')).textContent).toContain('no tunnel has the name')
    expect(screen.queryByLabelText('Token')).toBeNull()
  })

  it('issues a claim code for a tunnel and shows it once, with its expiry', async () => {
    // Arrange
    const relay = relayWith(['alice', 'bob'])
    const queryClient = renderScreen(await runtimeFor(relay, true))
    const user = userEvent.setup()

    // Act
    await user.click(await screen.findByRole('button', { name: 'Issue claim code for bob' }))

    // Assert
    expect((await screen.findByLabelText('Claim code')).textContent).toBe('ABCD-EFGH')
    expect(screen.getByRole('heading', { name: 'Claim code for bob' })).toBeDefined()
    expect(screen.getByText(/won’t be shown again/)).toBeDefined()
    expect(screen.getByText(/issued for this tunnel before it no longer works/)).toBeDefined()
    expect(document.querySelector('time[datetime="2023-11-14T22:28:20.000Z"]')).not.toBeNull()
    expect(relay.requests).toContain('POST /api/tunnels/bob/claim-codes')

    // Act
    await user.click(screen.getByRole('button', { name: 'Done' }))

    // Assert
    expect(screen.queryByLabelText('Claim code')).toBeNull()
    await waitFor(() => {
      expect(queryClient.getMutationCache().getAll()).toEqual([])
    })
  })

  it('shows the relay’s reason when a claim code’s tunnel is gone', async () => {
    // Arrange
    const relay = relayWith(['alice'])
    renderScreen(await runtimeFor(relay, true))
    const user = userEvent.setup()
    const issue = await screen.findByRole('button', { name: 'Issue claim code for alice' })
    relay.tunnels.delete('alice')

    // Act
    await user.click(issue)

    // Assert
    expect((await screen.findByRole('alert')).textContent).toContain('no tunnel has the name')
    expect(screen.queryByLabelText('Claim code')).toBeNull()
  })

  it('issues a claim code naming no tunnel and shows it once, with its expiry', async () => {
    // Arrange
    const relay = relayWith(['alice'])
    const queryClient = renderScreen(await runtimeFor(relay, true))
    const user = userEvent.setup()

    // Act
    await user.click(await screen.findByRole('button', { name: 'Issue claim code' }))

    // Assert
    expect((await screen.findByLabelText('Claim code')).textContent).toBe('JKMN-PQRS')
    expect(screen.getByRole('heading', { name: 'New claim code' })).toBeDefined()
    expect(screen.getByText(/under the email and subdomain they choose/)).toBeDefined()
    expect(screen.getByText(/won’t be shown again/)).toBeDefined()
    expect(document.querySelector('time[datetime="2023-11-14T22:28:20.000Z"]')).not.toBeNull()
    expect(relay.requests).toContain('POST /api/claim-codes')

    // Act
    await user.click(screen.getByRole('button', { name: 'Done' }))

    // Assert
    expect(screen.queryByLabelText('Claim code')).toBeNull()
    expect(screen.getByRole('button', { name: 'Issue claim code' })).toBeDefined()
    await waitFor(() => {
      expect(queryClient.getMutationCache().getAll()).toEqual([])
    })
  })

  it('drops a key the relay refuses and asks for it again, saying why', async () => {
    // Arrange
    const relay = relayWith(['alice'])
    relay.refuse = true
    const runtime = await runtimeFor(relay, true)

    // Act
    renderScreen(runtime)

    // Assert
    expect((await screen.findByRole('alert')).textContent).toBe(KEY_REFUSED_MESSAGE)
    expect(screen.getByLabelText('Admin key')).toBeDefined()
    expect(await holdsKey(runtime)).toBe(false)
  })

  it('drops the key when a change is refused too', async () => {
    // Arrange
    const relay = relayWith(['alice'])
    const runtime = await runtimeFor(relay, true)
    renderScreen(runtime)
    const user = userEvent.setup()
    await screen.findByText('alice.relay.example.com')
    relay.refuse = true

    // Act
    await user.type(screen.getByLabelText('Owner’s email'), 'carol@example.com')
    await user.click(screen.getByRole('button', { name: 'Create tunnel' }))

    // Assert
    expect((await screen.findByRole('alert')).textContent).toBe(KEY_REFUSED_MESSAGE)
    expect(await holdsKey(runtime)).toBe(false)
  })

  it('signs out by deleting the stored key', async () => {
    // Arrange
    const runtime = await runtimeFor(relayWith(['alice']), true)
    renderScreen(runtime)
    const user = userEvent.setup()
    await screen.findByText('alice.relay.example.com')

    // Act
    await user.click(screen.getByRole('button', { name: 'Sign out' }))

    // Assert
    expect(await screen.findByLabelText('Admin key')).toBeDefined()
    expect(screen.queryByText('alice.relay.example.com')).toBeNull()
    expect(await holdsKey(runtime)).toBe(false)
  })
})
