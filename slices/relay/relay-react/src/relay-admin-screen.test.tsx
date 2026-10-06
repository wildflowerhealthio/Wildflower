import { HttpClient, HttpClientResponse, type HttpClientRequest } from '@effect/platform'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { Effect, Layer, ManagedRuntime, Option, Schema } from 'effect'
import { RelayAdminHttpApiClient } from 'relay-core/clients'
import { Tunnels } from 'relay-core/http-api-definition'
import { AdminKeyStore, importAdminKey } from 'relay-core/key-store'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'

import { KEY_REFUSED_MESSAGE } from './admin-key-form.tsx'
import type { RelayAdminRuntime } from './relay-admin-context.ts'
import { RelayAdminProvider } from './relay-admin-provider.tsx'
import { RelayAdminScreen } from './relay-admin-screen.tsx'

/**
 * The whole screen, through the real hooks and the real `RelayAdminApi`
 * client, against an in-memory relay that answers as
 * `apps/relay/server/src/site/admin.rs` does. The signing `HttpClient` is
 * left out (`relay-core` tests it against the relay's verifier); the key
 * store is the in-memory one.
 */

const ADMIN_KEY = 'an-admin-key-of-thirty-two-bytes'
const DOMAIN = 'relay.example.com'

interface StoredTunnel {
  readonly email: string
  readonly created_at: number
}

/** The relay's tunnels and what it was asked; `refuse` answers every call `401`. */
interface FakeRelay {
  readonly tunnels: Map<string, StoredTunnel>
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
      }))
    )
  }
  if (request.method === 'POST' && url.pathname === '/api/tunnels') {
    const { email, name: chosen } = decodeCreateBody(
      request.body._tag === 'Uint8Array' ? new TextDecoder().decode(request.body.body) : ''
    )
    const tunnelName = chosen ?? 'calm-otter'
    if (tunnelName === 'admin') return text(409, 'the name is reserved')
    if (relay.tunnels.has(tunnelName)) return text(409, 'a tunnel already has the name')
    relay.tunnels.set(tunnelName, { email, created_at: 1_700_000_000 })
    return json(201, {
      name: tunnelName,
      token: `token-for-${tunnelName}`,
      public_host: `${tunnelName}.${DOMAIN}`,
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
    names.map((name) => [name, { email: `${name}@example.com`, created_at: 1_700_000_000 }])
  ),
  requests: [],
  refuse: false,
})

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
