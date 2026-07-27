import { HttpClient, type HttpClientRequest, HttpClientResponse } from '@effect/platform'
import type { CollectorDescriptor } from 'collector-fundamentals/model'
import {
  Arbitrary,
  Duration,
  Effect,
  FastCheck as fc,
  Fiber,
  Layer,
  TestClock,
  TestContext,
} from 'effect'
import { FhirR4ResourcesHttpApiClient, UnsupportedFhirResourceTypeError } from 'fhir-r4/clients'
import { DocumentReference, type FhirResource } from 'fhir-r4/resources'
import { describe, expect, it } from 'vite-plus/test'

import { describeResource, persistResources } from './persist.ts'

/**
 * Covers the web-trace persist sink (a verbatim copy of the Rexall / FHIR R4
 * sink), exercised on the resource this collector actually writes: a trace
 * `DocumentReference` routes to *its* `Update` endpoint via `upsertResource`,
 * and a resource still failing after its retries comes back as a
 * {@link CollectorDescriptor.PersistFailure} while the batch Effect itself never
 * fails — which is what keeps one bad exchange from losing a session. Driven
 * over the real `FhirR4ResourcesHttpApiClient` layer against a recording stub
 * `HttpClient`, with retry backoff on `TestClock`.
 */

const traceResource = (id: string | null): FhirResource => {
  const value = fc.sample(Arbitrary.make(DocumentReference.Schema), { numRuns: 1, seed: 7 })[0]
  if (value === undefined) throw new Error('unreachable: one sample requested')
  return { ...value, id }
}

describe('persistResources', () => {
  it('routes a trace DocumentReference to PUT /fhir-r4/DocumentReference/<id>', async () => {
    // The id is the codec's `{sessionId}-{requestId}`, so the write is an
    // idempotent upsert and a retry replaces rather than duplicates.
    const { records, failures } = await runPersist([traceResource('session-abc-req-1')])
    expect(failures).toEqual([])
    expect(records).toHaveLength(1)
    expect(records[0]?.method).toBe('PUT')
    expect(records[0]?.url).toContain('/fhir-r4/DocumentReference/session-abc-req-1')
  })

  it('writes a whole recorded batch concurrently', async () => {
    const batch = Array.from({ length: 5 }, (_, i) => traceResource(`session-abc-req-${i}`))
    const { records, failures } = await runPersist(batch)
    expect(failures).toEqual([])
    expect(records).toHaveLength(5)
  })

  it('skips a null-id resource without issuing any write, reporting no failure', async () => {
    const { records, failures } = await runPersist([traceResource(null)])
    expect(records).toEqual([])
    expect(failures).toEqual([])
  })

  it('reports a resource still failing after its retries as a PersistFailure, having retried it', async () => {
    const { records, failures } = await runPersist([traceResource('boom-1')], () => true)
    // One initial attempt + three retries.
    expect(records).toHaveLength(4)
    expect(failures).toHaveLength(1)
    expect(failures[0]?.failed).toEqual({ label: 'DocumentReference', id: 'boom-1' })
    expect(failures[0]?.cause).toBeDefined()
  })

  it('does not let one failed exchange lose the rest of the session', async () => {
    const good = traceResource('session-abc-req-ok')
    const bad = traceResource('session-abc-req-bad')
    const { failures } = await runPersist([good, bad], (request) =>
      request.url.includes('session-abc-req-bad')
    )
    expect(failures).toHaveLength(1)
    expect(failures[0]?.failed).toEqual({ label: 'DocumentReference', id: 'session-abc-req-bad' })
  })

  it('records an unsupported resourceType as a permanent failure — no write, no retry backoff', async () => {
    // A resourceType outside the `FhirResource` union only reaches the sink via
    // an untyped path; the cast fabricates exactly that scenario.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- deliberately forging an out-of-union resourceType to exercise the untyped-path branch
    const bogus = { resourceType: 'Practitioner', id: 'p-1' } as unknown as FhirResource
    const records: Array<RecordedRequest> = []
    const clientLayer = FhirR4ResourcesHttpApiClient.layer.pipe(
      Layer.provide(recordingHttpClientLayer(records, () => false))
    )
    const failures = await Effect.runPromise(
      persistResources([bogus]).pipe(
        Effect.provide(clientLayer),
        Effect.provide(TestContext.TestContext)
      )
    )
    expect(records).toEqual([])
    expect(failures).toHaveLength(1)
    expect(failures[0]?.failed).toEqual({ label: 'Practitioner', id: 'p-1' })
    expect(failures[0]?.cause).toBeInstanceOf(UnsupportedFhirResourceTypeError)
  })
})

describe('describeResource', () => {
  it('labels a trace resource by its FHIR resourceType and id', () => {
    expect(describeResource(traceResource('session-abc-req-1'))).toEqual({
      label: 'DocumentReference',
      id: 'session-abc-req-1',
    })
  })

  it('falls back to a sentinel id for a null-id resource', () => {
    expect(describeResource(traceResource(null))).toEqual({
      label: 'DocumentReference',
      id: '<no-id>',
    })
  })
})

// Helpers

interface RecordedRequest {
  readonly method: string
  readonly url: string
}

const recordingHttpClientLayer = (
  records: Array<RecordedRequest>,
  shouldFail: (request: HttpClientRequest.HttpClientRequest) => boolean
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      records.push({ method: request.method, url: request.url })
      if (shouldFail(request)) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response('', { status: 503 }))
        )
      }
      const body = request.body
      const payload = body._tag === 'Uint8Array' ? new TextDecoder().decode(body.body) : '{}'
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(payload, { status: 200, headers: { 'content-type': 'application/json' } })
        )
      )
    })
  )

const runPersist = async (
  resources: ReadonlyArray<FhirResource>,
  shouldFail: (request: HttpClientRequest.HttpClientRequest) => boolean = () => false
): Promise<{
  readonly records: ReadonlyArray<RecordedRequest>
  readonly failures: ReadonlyArray<CollectorDescriptor.PersistFailure>
}> => {
  const records: Array<RecordedRequest> = []
  const clientLayer = FhirR4ResourcesHttpApiClient.layer.pipe(
    Layer.provide(recordingHttpClientLayer(records, shouldFail))
  )
  const failures = await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.fork(
        persistResources(resources).pipe(Effect.provide(clientLayer))
      )
      yield* TestClock.adjust(Duration.seconds(2))
      return yield* Fiber.join(fiber)
    }).pipe(Effect.provide(TestContext.TestContext))
  )
  return { records, failures }
}
