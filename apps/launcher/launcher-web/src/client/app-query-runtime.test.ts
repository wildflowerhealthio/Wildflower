import { HttpClient, HttpClientRequest, HttpClientResponse } from '@effect/platform'
import { makeBearerAuthStateStore } from '@wildflowerhealthio/authorization-react'
import { FhirR4ResourcesHttpApiClient } from '@wildflowerhealthio/fhir-r4/clients'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Effect, Layer } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { buildRunAuthed } from '../runtime-layer.ts'
import { apiTransport, type ApiSession } from './app-query-runtime.ts'

/**
 * Where the launcher's requests land. Only the transport is a stub: the real
 * `apiTransport` feeds the real `buildRunAuthed`, and the FHIR read goes
 * through the real typed client, so the URL each request reaches the wire with
 * is the one production sends.
 */

describe('apiTransport', () => {
  it("should address the FHIR slice's reads to the API origin's root, where FHIR is served", async () => {
    // Arrange
    const { runAuthed, recorded } = runnerOver('http://127.0.0.1:8080', undefined)

    // Act
    await runAuthed(searchPatients)

    // Assert
    expect(recorded.map((request) => request.url)).toEqual(['http://127.0.0.1:8080/Patient'])
  })

  it("should address every other slice's requests to the API origin's root", async () => {
    // Arrange
    const { runAuthed, recorded } = runnerOver('http://127.0.0.1:8080', undefined)

    // Act
    await runAuthed(getFromRoot('/authorization/clients'))

    // Assert
    expect(recorded.map((request) => request.url)).toEqual([
      'http://127.0.0.1:8080/authorization/clients',
    ])
  })

  it('should send nothing while no server is signed in to', async () => {
    // Arrange
    const { runAuthed, recorded } = runnerOver(undefined, undefined)

    // Act
    const outcome = await runAuthed(getFromRoot('/authorization/clients')).then(
      () => 'sent',
      () => 'refused'
    )

    // Assert
    expect(outcome).toBe('refused')
    expect(recorded).toEqual([])
  })

  it("should send a request to the session's server with the session's bearer", async () => {
    // Arrange — a sign-in writes the server and the bearer together.
    const session = makeBearerAuthStateStore(memoryStorage(), 'test.signed-in-server')
    session.writeSession({ serverUrl: 'https://ruth.relay.example', bearer: 'owner-token' })
    const { runAuthed, recorded } = runnerOverSession(session)

    // Act
    await runAuthed(getFromRoot('/apps'))

    // Assert
    expect(recorded).toEqual([
      { url: 'https://ruth.relay.example/apps', authorization: 'Bearer owner-token' },
    ])
  })

  it('should follow the session to the server a later sign-in names', async () => {
    // Arrange
    const session = makeBearerAuthStateStore(memoryStorage(), 'test.signed-in-server')
    const { runAuthed, recorded } = runnerOverSession(session)
    session.writeSession({ serverUrl: 'https://first.relay.example', bearer: 'first-token' })
    await runAuthed(getFromRoot('/apps'))

    // Act
    session.writeSession({ serverUrl: 'https://second.relay.example', bearer: 'second-token' })
    await runAuthed(getFromRoot('/apps'))

    // Assert
    expect(recorded).toEqual([
      { url: 'https://first.relay.example/apps', authorization: 'Bearer first-token' },
      { url: 'https://second.relay.example/apps', authorization: 'Bearer second-token' },
    ])
  })

  it('should carry the bearer on FHIR reads as well as on root requests', async () => {
    // Arrange
    const { runAuthed, recorded } = runnerOver('http://127.0.0.1:8080', 'owner-token')

    // Act
    await runAuthed(searchPatients)
    await runAuthed(getFromRoot('/authorization/clients'))

    // Assert
    expect(recorded.map((request) => request.authorization)).toEqual([
      'Bearer owner-token',
      'Bearer owner-token',
    ])
  })

  it("should always send FHIR reads to the origin's root, whatever the origin", async () => {
    await fc.assert(
      fc.asyncProperty(originArb, async (origin) => {
        // Arrange
        const { runAuthed, recorded } = runnerOver(origin, undefined)

        // Act
        await runAuthed(searchPatients)

        // Assert
        expect(recorded.map((request) => request.url)).toEqual([`${origin}/Patient`])
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })
})

// Helpers

interface RecordedRequest {
  readonly url: string
  readonly authorization: string | undefined
}

/** An in-memory stand-in for the tab's `sessionStorage`. */
const memoryStorage = (): Pick<Storage, 'getItem' | 'setItem'> => {
  const entries = new Map<string, string>()
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value)
    },
  }
}

/** A runner over a session that holds `serverUrl` and `bearer` as they are. */
const runnerOver = (
  serverUrl: string | undefined,
  bearer: string | undefined
): ReturnType<typeof runnerOverSession> =>
  runnerOverSession({ serverUrl: () => serverUrl, bearer: () => bearer })

/**
 * A runner over `session`, through a stub transport that records each request
 * and answers an empty searchset.
 */
const runnerOverSession = (
  session: ApiSession
): {
  readonly runAuthed: ReturnType<typeof buildRunAuthed>['runAuthed']
  readonly recorded: RecordedRequest[]
} => {
  const recorded: RecordedRequest[] = []
  const transport = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      recorded.push({ url: request.url, authorization: request.headers['authorization'] })
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify({ resourceType: 'Bundle', type: 'searchset' }), {
            status: 200,
            headers: { 'content-type': 'application/fhir+json' },
          })
        )
      )
    })
  )
  const { runAuthed } = buildRunAuthed(apiTransport(transport, session), Layer.empty)
  return { runAuthed, recorded }
}

/** A FHIR `Patient` search through the typed client — what the consent page's picker issues. */
const searchPatients = Effect.gen(function* () {
  const client = yield* FhirR4ResourcesHttpApiClient
  return yield* client.Patient.SearchByGet({ urlParams: {} })
})

/** A plain request to `path` on the root-mounted transport. */
const getFromRoot = (path: string): Effect.Effect<number, unknown, HttpClient.HttpClient> =>
  Effect.flatMap(HttpClient.HttpClient, (client) =>
    Effect.map(client.execute(HttpClientRequest.get(path)), (response) => response.status)
  )

/** An API origin: scheme, host and port, no path and no trailing slash. */
const originArb = fc
  .tuple(fc.constantFrom('http', 'https'), fc.domain(), fc.integer({ min: 1, max: 65535 }))
  .map(([scheme, host, port]) => `${scheme}://${host}:${port}`)
