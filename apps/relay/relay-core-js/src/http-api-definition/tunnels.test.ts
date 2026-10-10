import { HttpClient, HttpClientRequest, HttpClientResponse } from '@effect/platform'
import { DateTime, Effect, Either, Layer } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { RelayAdminHttpApiClient } from '../clients/index.ts'

/** What the fake relay answers, and the requests it saw. */
interface FakeRelay {
  readonly layer: Layer.Layer<RelayAdminHttpApiClient>
  readonly requests: HttpClientRequest.HttpClientRequest[]
  readonly bodies: string[]
}

/** The admin client over a transport answering every request with `answer`. */
const fakeRelay = (answer: () => Response): FakeRelay => {
  const requests: HttpClientRequest.HttpClientRequest[] = []
  const bodies: string[] = []
  const transport = HttpClient.make((request) => {
    requests.push(request)
    bodies.push(
      request.body._tag === 'Uint8Array' ? new TextDecoder().decode(request.body.body) : ''
    )
    return Effect.succeed(HttpClientResponse.fromWeb(request, answer()))
  }).pipe(HttpClient.mapRequest(HttpClientRequest.prependUrl('https://admin.relay.example.com')))
  return {
    layer: RelayAdminHttpApiClient.layer.pipe(
      Layer.provide(Layer.succeed(HttpClient.HttpClient, transport))
    ),
    requests,
    bodies,
  }
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const text = (status: number, body: string): Response =>
  new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } })

/** Run `use` against the admin client over `relay`, as an `Either`. */
const call = <A, E>(
  relay: FakeRelay,
  use: (client: typeof RelayAdminHttpApiClient.Service) => Effect.Effect<A, E>
): Promise<Either.Either<A, E>> =>
  Effect.runPromise(
    Effect.either(Effect.flatMap(RelayAdminHttpApiClient, use)).pipe(Effect.provide(relay.layer))
  )

const expectUnauthorized = (result: Either.Either<unknown, unknown>): void => {
  expect(Either.isLeft(result) && result.left).toMatchObject({ _tag: 'Unauthorized' })
}

describe('RelayAdminApi over the relay wire', () => {
  it('lists tunnels with created_at as a UTC time', async () => {
    // Arrange
    const relay = fakeRelay(() =>
      json(200, [
        {
          name: 'alice',
          email: 'alice@example.com',
          public_host: 'alice.relay.example.com',
          created_at: 1_700_000_000,
        },
      ])
    )

    // Act
    const listed = await call(relay, (client) => client.tunnels.ListTunnels())

    // Assert
    expect(relay.requests[0]?.method).toBe('GET')
    expect(relay.requests[0]?.url).toBe('https://admin.relay.example.com/api/tunnels')
    expect(listed).toEqual(
      Either.right([
        {
          name: 'alice',
          email: 'alice@example.com',
          public_host: 'alice.relay.example.com',
          created_at: DateTime.unsafeMake(1_700_000_000_000),
        },
      ])
    )
  })

  it('creates a tunnel, leaving out a name it was not given, and reads the token from the 201', async () => {
    // Arrange
    const created = {
      name: 'calm-otter',
      token: 't'.repeat(43),
      public_host: 'calm-otter.relay.example.com',
    }
    const relay = fakeRelay(() => json(201, created))

    // Act
    const result = await call(relay, (client) =>
      client.tunnels.CreateTunnel({ payload: { email: 'carol@example.com' } })
    )

    // Assert
    expect(relay.requests[0]?.url).toBe('https://admin.relay.example.com/api/tunnels')
    expect(JSON.parse(relay.bodies[0] ?? '')).toEqual({ email: 'carol@example.com' })
    expect(result).toEqual(Either.right(created))
  })

  it.each([
    [409, 'a tunnel already has the name', 'TunnelNameConflict'],
    [409, 'the name is reserved', 'TunnelNameConflict'],
    [422, 'the name is not a lowercase DNS label', 'TunnelRejected'],
    [503, 'no name is left', 'TunnelNamesExhausted'],
  ])('fails a create answered %i with the relay’s reason', async (status, reason, tag) => {
    // Arrange
    const relay = fakeRelay(() => text(status, reason))

    // Act
    const result = await call(relay, (client) =>
      client.tunnels.CreateTunnel({ payload: { email: 'x@example.com', name: 'alice' } })
    )

    // Assert
    expect(Either.isLeft(result) && result.left).toMatchObject({ _tag: tag, reason })
  })

  it('deletes with a 204 and fails a 404 with the reason', async () => {
    // Arrange
    const gone = fakeRelay(() => new Response(null, { status: 204 }))
    const missing = fakeRelay(() => text(404, 'no tunnel has the name'))

    // Act
    const deleted = await call(gone, (client) =>
      client.tunnels.DeleteTunnel({ path: { name: 'bob' } })
    )
    const notFound = await call(missing, (client) =>
      client.tunnels.DeleteTunnel({ path: { name: 'nobody' } })
    )

    // Assert
    expect(gone.requests[0]?.method).toBe('DELETE')
    expect(gone.requests[0]?.url).toBe('https://admin.relay.example.com/api/tunnels/bob')
    expect(deleted).toEqual(Either.right(undefined))
    expect(Either.isLeft(notFound) && notFound.left).toMatchObject({
      _tag: 'TunnelNotFound',
      reason: 'no tunnel has the name',
    })
  })

  it('fails any call answered with the bare 401 as Unauthorized', async () => {
    // Arrange
    const relay = fakeRelay(() => new Response(null, { status: 401 }))

    // Act
    const results = [
      await call(relay, (client) => client.tunnels.ListTunnels()),
      await call(relay, (client) =>
        client.tunnels.CreateTunnel({ payload: { email: 'x@example.com' } })
      ),
      await call(relay, (client) => client.tunnels.DeleteTunnel({ path: { name: 'bob' } })),
    ]

    // Assert
    for (const result of results) expectUnauthorized(result)
  })
})
