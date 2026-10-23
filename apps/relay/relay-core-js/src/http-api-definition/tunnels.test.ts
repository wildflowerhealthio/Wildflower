import { readFileSync } from 'node:fs'

import { HttpClient, HttpClientRequest, HttpClientResponse } from '@effect/platform'
import { DateTime, Effect, Either, Layer, Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { RelayAdminHttpApiClient } from '../clients/index.ts'

/**
 * The admin API's list bodies as the relay serializes them:
 * `apps/relay/relay-server`'s
 * `the_admin_wire_fixture_matches_what_the_relay_serializes` test builds the
 * same values and checks they serialize to exactly this file.
 */
const ADMIN_WIRE_URL = new URL('./fixtures/admin-wire.json', import.meta.url)

const AdminWireFixture = Schema.Struct({
  ListTunnels: Schema.Unknown,
  ListConnectionTotals: Schema.Unknown,
})

const adminWire = Schema.decodeUnknownSync(Schema.parseJson(AdminWireFixture))(
  readFileSync(ADMIN_WIRE_URL, 'utf8')
)

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
          last_outcome: null,
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
          last_outcome: null,
        },
      ])
    )
  })

  it('decodes the relay’s tunnel list from the shared wire fixture', async () => {
    // Arrange
    const relay = fakeRelay(() => json(200, adminWire.ListTunnels))

    // Act
    const listed = await call(relay, (client) => client.tunnels.ListTunnels())

    // Assert
    expect(listed).toEqual(
      Either.right([
        {
          name: 'alice',
          email: 'alice@example.com',
          public_host: 'alice.relay.example.com',
          created_at: DateTime.unsafeMake(1_700_000_000_000),
          last_outcome: 'tunnel_down',
        },
        {
          name: 'bob',
          email: 'bob@example.com',
          public_host: 'bob.relay.example.com',
          created_at: DateTime.unsafeMake(1_700_000_000_000),
          last_outcome: null,
        },
      ])
    )
  })

  it('decodes the relay’s connection totals from the shared wire fixture', async () => {
    // Arrange
    const relay = fakeRelay(() => json(200, adminWire.ListConnectionTotals))

    // Act
    const listed = await call(relay, (client) => client.tunnels.ListConnectionTotals())

    // Assert
    expect(relay.requests[0]?.url).toBe('https://admin.relay.example.com/api/connection-totals')
    expect(listed).toEqual(
      Either.right([
        {
          hour: DateTime.unsafeMake(1_699_999_200_000),
          ok: 12,
          over_connection_limit: 0,
          hello_timeout: 0,
          not_a_hello: 0,
          no_server_name: 0,
          unknown_tunnel: 3,
          tunnel_down: 1,
          tunnel_busy: 0,
          tunnel_closed: 0,
          proxy_header_failed: 0,
        },
        {
          hour: DateTime.unsafeMake(1_700_002_800_000),
          ok: 1,
          over_connection_limit: 2,
          hello_timeout: 3,
          not_a_hello: 4,
          no_server_name: 5,
          unknown_tunnel: 6,
          tunnel_down: 7,
          tunnel_busy: 8,
          tunnel_closed: 9,
          proxy_header_failed: 10,
        },
      ])
    )
  })

  it('refuses a last outcome the relay does not send', async () => {
    // Arrange
    const relay = fakeRelay(() =>
      json(200, [
        {
          name: 'alice',
          email: 'alice@example.com',
          public_host: 'alice.relay.example.com',
          created_at: 1_700_000_000,
          last_outcome: 'unknown_tunnel',
        },
      ])
    )

    // Act
    const listed = await call(relay, (client) => client.tunnels.ListTunnels())

    // Assert
    expect(Either.isLeft(listed)).toBe(true)
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

  it('issues a claim code with an empty POST and reads its expiry as a UTC time', async () => {
    // Arrange
    const relay = fakeRelay(() => json(201, { code: 'ABCD-EFGH', expires_at: 1_700_000_900 }))

    // Act
    const issued = await call(relay, (client) =>
      client.tunnels.IssueClaimCode({ path: { name: 'bob' } })
    )

    // Assert
    expect(relay.requests[0]?.method).toBe('POST')
    expect(relay.requests[0]?.url).toBe(
      'https://admin.relay.example.com/api/tunnels/bob/claim-codes'
    )
    expect(relay.bodies[0]).toBe('')
    expect(issued).toEqual(
      Either.right({ code: 'ABCD-EFGH', expires_at: DateTime.unsafeMake(1_700_000_900_000) })
    )
  })

  it('issues an access code with an empty POST and reads its expiry as a UTC time', async () => {
    // Arrange
    const relay = fakeRelay(() => json(201, { code: 'JKMN-PQRS', expires_at: 1_700_000_900 }))

    // Act
    const issued = await call(relay, (client) => client.tunnels.IssueAccessCode())

    // Assert
    expect(relay.requests[0]?.method).toBe('POST')
    expect(relay.requests[0]?.url).toBe('https://admin.relay.example.com/api/access-codes')
    expect(relay.bodies[0]).toBe('')
    expect(issued).toEqual(
      Either.right({ code: 'JKMN-PQRS', expires_at: DateTime.unsafeMake(1_700_000_900_000) })
    )
  })

  it('fails a claim code for an unknown tunnel with the reason', async () => {
    // Arrange
    const relay = fakeRelay(() => text(404, 'no tunnel has the name'))

    // Act
    const result = await call(relay, (client) =>
      client.tunnels.IssueClaimCode({ path: { name: 'nobody' } })
    )

    // Assert
    expect(Either.isLeft(result) && result.left).toMatchObject({
      _tag: 'TunnelNotFound',
      reason: 'no tunnel has the name',
    })
  })

  it('reissues a token with an empty POST and reads the tunnel from the 200', async () => {
    // Arrange
    const relay = fakeRelay(() =>
      json(200, { name: 'bob', token: 'new-token', public_host: 'bob.relay.example.com' })
    )

    // Act
    const reissued = await call(relay, (client) =>
      client.tunnels.ReissueToken({ path: { name: 'bob' } })
    )

    // Assert
    expect(relay.requests[0]?.method).toBe('POST')
    expect(relay.requests[0]?.url).toBe('https://admin.relay.example.com/api/tunnels/bob/token')
    expect(relay.bodies[0]).toBe('')
    expect(reissued).toEqual(
      Either.right({ name: 'bob', token: 'new-token', public_host: 'bob.relay.example.com' })
    )
  })

  it('fails a reissue for an unknown tunnel with the reason', async () => {
    // Arrange
    const relay = fakeRelay(() => text(404, 'no tunnel has the name'))

    // Act
    const result = await call(relay, (client) =>
      client.tunnels.ReissueToken({ path: { name: 'nobody' } })
    )

    // Assert
    expect(Either.isLeft(result) && result.left).toMatchObject({
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
      await call(relay, (client) => client.tunnels.IssueClaimCode({ path: { name: 'bob' } })),
      await call(relay, (client) => client.tunnels.ReissueToken({ path: { name: 'bob' } })),
      await call(relay, (client) => client.tunnels.ListConnectionTotals()),
    ]

    // Assert
    for (const result of results) expectUnauthorized(result)
  })
})
