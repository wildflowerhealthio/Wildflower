import { HttpClient, HttpClientRequest, HttpClientResponse } from '@effect/platform'
import { Effect, Layer } from 'effect'
import * as fc from 'fast-check'
import { FhirR4ResourcesHttpApiClient } from 'fhir-r4/clients'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { buildRunAuthed } from '../runtime-layer.ts'
import { apiTransportAt } from './app-query-runtime.ts'

/**
 * Where the owner UI's requests land. Only the transport is a stub: the real
 * `apiTransportAt` feeds the real `buildRunAuthed`, and the FHIR read goes
 * through the real typed client, so the URL each request reaches the wire with
 * is the one production sends.
 */

describe('apiTransportAt', () => {
  it("should address the FHIR slice's reads to the API origin's /fhir-r4 mount", async () => {
    // Arrange
    const { runAuthed, recorded } = runnerOver('http://127.0.0.1:8080', undefined)

    // Act
    await runAuthed(searchPatients)

    // Assert
    expect(recorded.map((request) => request.url)).toEqual([
      'http://127.0.0.1:8080/fhir-r4/Patient',
    ])
  })

  it("should address every other slice's requests to the API origin's root", async () => {
    // Arrange
    const { runAuthed, recorded } = runnerOver('http://127.0.0.1:8080', undefined)

    // Act
    await runAuthed(getFromRoot('/access/clients'))

    // Assert
    expect(recorded.map((request) => request.url)).toEqual(['http://127.0.0.1:8080/access/clients'])
  })

  it('should keep both mounts page-relative when the page is served by the API server', async () => {
    // Arrange
    const { runAuthed, recorded } = runnerOver(undefined, undefined)

    // Act
    await runAuthed(searchPatients)
    await runAuthed(getFromRoot('/access/clients'))

    // Assert
    expect(recorded.map((request) => request.url)).toEqual(['/fhir-r4/Patient', '/access/clients'])
  })

  it('should carry the bearer on FHIR reads as well as on root requests', async () => {
    // Arrange
    const { runAuthed, recorded } = runnerOver('http://127.0.0.1:8080', () => 'owner-token')

    // Act
    await runAuthed(searchPatients)
    await runAuthed(getFromRoot('/access/clients'))

    // Assert
    expect(recorded.map((request) => request.authorization)).toEqual([
      'Bearer owner-token',
      'Bearer owner-token',
    ])
  })

  it('should always send FHIR reads to {origin}/fhir-r4, whatever the origin', async () => {
    await fc.assert(
      fc.asyncProperty(originArb, async (origin) => {
        // Arrange
        const { runAuthed, recorded } = runnerOver(origin, undefined)

        // Act
        await runAuthed(searchPatients)

        // Assert
        expect(recorded.map((request) => request.url)).toEqual([`${origin}/fhir-r4/Patient`])
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

/** A runner over a stub transport that records each request and answers an empty searchset. */
const runnerOver = (
  apiBaseUrl: string | undefined,
  readBearer: (() => string | undefined) | undefined
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
  const { runAuthed } = buildRunAuthed(
    apiTransportAt(transport, apiBaseUrl, readBearer),
    Layer.empty
  )
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
