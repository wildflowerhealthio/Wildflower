import { HttpClient, HttpClientRequest, HttpClientResponse } from '@effect/platform'
import {
  Arbitrary,
  Duration,
  Effect,
  FastCheck as fc,
  Fiber,
  Layer,
  type Schema,
  TestClock,
  TestContext,
} from 'effect'
import { FhirR4ResourcesHttpApiClient, type ResourceWriteFailure } from 'fhir-r4/clients'
import { type FhirResource, Observation, Patient } from 'fhir-r4/resources'
import { describe, expect, it } from 'vite-plus/test'

import type { Preview } from './import-preview.ts'
import { persist } from './persist-preview.ts'

/**
 * Covers the write half of the import flow. Two properties matter and both are
 * delegated deliberately — the source stamp to `web-trace-core`'s
 * `withMetaSource`, the write itself to `fhir-r4`'s `persistResources` — so the
 * tests pin the seam, not a reimplementation:
 *
 * - **Every written resource carries `meta.source = sourceRef`.** Captured off
 *   the wire against a recording stub `HttpClient`, cast-free.
 * - **Failures come back as data, one bad write never stops the rest, and
 *   nothing throws.** Driven over the real `FhirR4ResourcesHttpApiClient` layer;
 *   retry backoff runs on `TestClock` so the failure paths don't wait on the
 *   real clock.
 */

/** The HAR-archive `DocumentReference` every imported resource points back to. */
const SOURCE_REF = 'DocumentReference/har-archive-1'

/** One deterministic, schema-valid resource with a known id and no `meta` set. */
const genWithId = <A extends FhirResource, I>(
  schema: Schema.Schema<A, I>,
  id: string
): FhirResource => {
  const value = fc.sample(Arbitrary.make(schema), { numRuns: 1, seed: 7 })[0]
  if (value === undefined) throw new Error('unreachable: one sample requested')
  return { ...value, id, meta: null }
}

/** A `Preview` carrying exactly the given resources, grouped by type. */
const previewOf = (
  resourcesByType: Readonly<Record<string, readonly FhirResource[]>>
): Preview => ({
  rootUrls: ['https://r4.example.org/baseR4'],
  resourcesByType,
  parseFailures: [],
  unmatchedCount: 0,
  bodyAbsentCount: 0,
  totalResponses: Object.values(resourcesByType).flat().length,
})

describe('ImportPreview.persist', () => {
  it('stamps every written resource with meta.source = sourceRef', async () => {
    const preview = previewOf({
      Patient: [genWithId(Patient.Schema, 'pat-1'), genWithId(Patient.Schema, 'pat-2')],
      Observation: [genWithId(Observation.Schema, 'obs-1')],
    })
    const { records, failures } = await runPersist(preview)

    expect(failures).toEqual([])
    expect(records).toHaveLength(3)
    for (const record of records) {
      expect(record.method).toBe('PUT')
      const written: unknown = JSON.parse(record.body)
      expect(written).toMatchObject({ meta: { source: SOURCE_REF } })
    }
  })

  it('returns write failures as data without throwing, and one failure does not stop the rest', async () => {
    const preview = previewOf({
      Patient: [genWithId(Patient.Schema, 'ok-1')],
      Observation: [genWithId(Observation.Schema, 'bad-1')],
    })
    const { records, failures } = await runPersist(preview, (request) =>
      request.url.includes('/Observation/')
    )

    // The Patient wrote fine; only the Observation is returned as a failure.
    expect(failures).toHaveLength(1)
    expect(failures[0]?.failed).toEqual({ label: 'Observation', id: 'bad-1' })
    // It was actually written back the meta.source before failing — the stamp is
    // not skipped for a resource that happens to fail.
    const observationWrites = records.filter((record) => record.url.includes('/Observation/'))
    for (const record of observationWrites) {
      expect(JSON.parse(record.body)).toMatchObject({ meta: { source: SOURCE_REF } })
    }
  })

  it('writes nothing for an empty preview, issuing no requests', async () => {
    // The client is provided (persist always requires it), but a preview that
    // recognized nothing has no resources to write — the recorder stays empty.
    const records: Array<RecordedRequest> = []
    const clientLayer = FhirR4ResourcesHttpApiClient.layer.pipe(
      Layer.provide(recordingHttpClientLayer(records, () => false))
    )
    const failures = await Effect.runPromise(
      persist(previewOf({}), SOURCE_REF).pipe(Effect.provide(clientLayer))
    )
    expect(failures).toEqual([])
    expect(records).toEqual([])
  })
})

// Helpers

interface RecordedRequest {
  readonly method: string
  readonly url: string
  readonly body: string
}

const TEST_ORIGIN = 'http://fhir-r4.test'

/**
 * A stub `HttpClient` that records every request (method, url, and decoded
 * body). It echoes the request payload back as a 200 so the write decodes and
 * succeeds, unless `shouldFail` forces a `503 ServiceUnavailable`.
 */
const recordingHttpClientLayer = (
  records: Array<RecordedRequest>,
  shouldFail: (request: HttpClientRequest.HttpClientRequest) => boolean
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.mapRequest(
      HttpClient.make((request) => {
        const body = request.body
        const payload = body._tag === 'Uint8Array' ? new TextDecoder().decode(body.body) : '{}'
        records.push({ method: request.method, url: request.url, body: payload })
        if (shouldFail(request)) {
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response('', { status: 503 }))
          )
        }
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(payload, { status: 200, headers: { 'content-type': 'application/json' } })
          )
        )
      }),
      HttpClientRequest.prependUrl(TEST_ORIGIN)
    )
  )

/**
 * Persist a preview over the real client + recording stub, returning the
 * recorded requests and the sink's reported failures. Retry backoff runs on
 * `TestClock` (a 2s virtual jump covers the 250 + 500 + 1000ms schedule).
 */
const runPersist = async (
  preview: Preview,
  shouldFail: (request: HttpClientRequest.HttpClientRequest) => boolean = () => false
): Promise<{
  readonly records: ReadonlyArray<RecordedRequest>
  readonly failures: ReadonlyArray<ResourceWriteFailure>
}> => {
  const records: Array<RecordedRequest> = []
  const clientLayer = FhirR4ResourcesHttpApiClient.layer.pipe(
    Layer.provide(recordingHttpClientLayer(records, shouldFail))
  )
  const failures = await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.fork(
        persist(preview, SOURCE_REF).pipe(Effect.provide(clientLayer))
      )
      yield* TestClock.adjust(Duration.seconds(2))
      return yield* Fiber.join(fiber)
    }).pipe(Effect.provide(TestContext.TestContext))
  )
  return { records, failures }
}
