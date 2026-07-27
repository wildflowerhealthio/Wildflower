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
import { describe, expect, it } from 'vite-plus/test'

import {
  Binary,
  DocumentReference,
  type FhirResource,
  MedicationDispense,
  MedicationRequest,
  Observation,
  Patient,
} from '../resources/index.ts'
import { FhirR4ResourcesHttpApiClient } from './fhir-r4-resources-http-api-client.ts'
import {
  describeResource,
  makePersistResources,
  type ResourceWriteFailure,
} from './persist-resources.ts'
import { UnsupportedFhirResourceTypeError } from './upsert-resource.ts'

/**
 * Covers the shared batch write — the sink every `*-client-collector` uses as
 * its descriptor's `persistResources`. Two concerns:
 *
 * - **Routing**: each resource type reaches *its* client group's `Update`
 *   endpoint (a `PUT /fhir-r4/<Type>/<id>`), keyed on the resource's id. Driven
 *   over the real `FhirR4ResourcesHttpApiClient` layer against a recording stub
 *   `HttpClient` — cast-free. (The `switch` itself lives in `upsertResource`;
 *   this pins that a batch reaches it correctly.)
 * - **Failure accounting**: the sink owns retries, so a resource still failing
 *   after them comes back as a {@link ResourceWriteFailure} (with its cause)
 *   while the batch Effect itself never fails — one bad resource can't sink the
 *   caller's run.
 *
 * The stub echoes each request's payload back as a 200 so the write decodes and
 * succeeds (no retry); `shouldFail` forces a `503 ServiceUnavailable` for the
 * failure paths. Retry backoff is driven by `TestClock`, so the retry tests
 * don't wait on the real clock. Valid payloads come from each resource schema's
 * arbitrary (a fixed seed keeps them deterministic).
 */

/** Stands in for a caller's telemetry vocabulary; the sink never supplies its own. */
const TEST_OPTIONS = {
  spanName: 'test.importing.update',
  kindAttributeKey: 'test.importing.resource.kind',
  logLabel: 'test persist',
} as const

const persistResources = makePersistResources(TEST_OPTIONS)

describe('makePersistResources', () => {
  for (const { resourceType, make } of cases) {
    it(`routes ${resourceType} to PUT /fhir-r4/${resourceType}/<id>`, async () => {
      const id = `${resourceType}-1`
      const { records, failures } = await runPersist([make(id)])
      expect(failures).toEqual([])
      expect(records).toHaveLength(1)
      expect(records[0]?.method).toBe('PUT')
      expect(records[0]?.url).toContain(`/fhir-r4/${resourceType}/${id}`)
    })
  }

  it('writes a whole batch, one PUT per resource', async () => {
    const batch = cases.map(({ resourceType, make }) => make(`${resourceType}-batch`))
    const { records, failures } = await runPersist(batch)
    expect(failures).toEqual([])
    expect(records).toHaveLength(cases.length)
  })

  it('skips a null-id resource without issuing any write, reporting no failure', async () => {
    const { records, failures } = await runPersist([byType('Patient').make(null)])
    expect(records).toEqual([])
    expect(failures).toEqual([])
  })

  it('reports a resource still failing after its retries as a failure, having retried it', async () => {
    const { records, failures } = await runPersist([byType('Patient').make('boom-1')], () => true)
    // One initial attempt + three retries.
    expect(records).toHaveLength(4)
    expect(failures).toHaveLength(1)
    expect(failures[0]?.failed).toEqual({ label: 'Patient', id: 'boom-1' })
    expect(failures[0]?.cause).toBeDefined()
  })

  it('does not let one failed resource fail the rest of the batch', async () => {
    const good = byType('Patient').make('ok-1')
    const bad = byType('Observation').make('bad-1')
    const { failures } = await runPersist([good, bad], (request) =>
      request.url.includes('/Observation/')
    )
    // Only the Observation comes back; the Patient wrote fine.
    expect(failures).toHaveLength(1)
    expect(failures[0]?.failed).toEqual({ label: 'Observation', id: 'bad-1' })
  })

  it('records an unsupported resourceType as a permanent failure — no write, no retry backoff', async () => {
    // A resourceType outside the `FhirResource` union only reaches the sink via
    // an untyped path; the cast fabricates exactly that scenario (there is no
    // in-type way to build one). `upsertResource` fails in its exhaustive-default
    // arm before any client call.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- deliberately forging an out-of-union resourceType to exercise the untyped-path branch
    const bogus = { resourceType: 'Practitioner', id: 'p-1' } as unknown as FhirResource
    const records: Array<RecordedRequest> = []
    const clientLayer = FhirR4ResourcesHttpApiClient.layer.pipe(
      Layer.provide(recordingHttpClientLayer(records, () => false))
    )
    // Deliberately *no* `TestClock.adjust`: a retried failure would park on the
    // first 250ms backoff `sleep` and never resolve (the virtual clock is never
    // advanced). The permanent `UnsupportedFhirResourceTypeError` is not retried,
    // so this resolves at once — the test would hang if the sink retried it.
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

  it('reports failures under whatever log label the caller supplied', async () => {
    // The caller-owned half of the options: two sinks built from the same
    // factory stay independent, which is what lets `fhir-r4` host this without
    // naming any one consumer's vocabulary.
    const other = makePersistResources({ ...TEST_OPTIONS, logLabel: 'other persist' })
    const records: Array<RecordedRequest> = []
    const clientLayer = FhirR4ResourcesHttpApiClient.layer.pipe(
      Layer.provide(recordingHttpClientLayer(records, () => true))
    )
    const failures = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(
          other([byType('Patient').make('x-1')]).pipe(Effect.provide(clientLayer))
        )
        yield* TestClock.adjust(Duration.seconds(2))
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestContext.TestContext))
    )
    expect(failures).toHaveLength(1)
  })
})

describe('describeResource', () => {
  it('labels a resource by its FHIR resourceType and id', () => {
    expect(describeResource(byType('Observation').make('obs-1'))).toEqual({
      label: 'Observation',
      id: 'obs-1',
    })
  })

  it('falls back to a sentinel id for a null-id resource', () => {
    expect(describeResource(byType('Binary').make(null))).toEqual({
      label: 'Binary',
      id: '<no-id>',
    })
  })
})

// Helpers

interface RecordedRequest {
  readonly method: string
  readonly url: string
}

/** One deterministic, schema-valid resource with a known (or null) id. */
const genWithId = <A extends FhirResource, I>(
  schema: Schema.Schema<A, I>,
  id: string | null
): FhirResource => {
  const value = fc.sample(Arbitrary.make(schema), { numRuns: 1, seed: 7 })[0]
  if (value === undefined) throw new Error('unreachable: one sample requested')
  return { ...value, id }
}

/**
 * Every registered resource type paired with a monomorphic maker over its
 * concrete schema — mirrors `upsertResource`'s switch, so a resource type added
 * there without a case here shows up as a missing entry.
 */
const cases: ReadonlyArray<{
  readonly resourceType: FhirResource['resourceType']
  readonly make: (id: string | null) => FhirResource
}> = [
  { resourceType: 'Patient', make: (id) => genWithId(Patient.Schema, id) },
  { resourceType: 'Observation', make: (id) => genWithId(Observation.Schema, id) },
  { resourceType: 'Binary', make: (id) => genWithId(Binary.Schema, id) },
  { resourceType: 'MedicationRequest', make: (id) => genWithId(MedicationRequest.Schema, id) },
  { resourceType: 'MedicationDispense', make: (id) => genWithId(MedicationDispense.Schema, id) },
  { resourceType: 'DocumentReference', make: (id) => genWithId(DocumentReference.Schema, id) },
]

const byType = (resourceType: FhirResource['resourceType']): (typeof cases)[number] => {
  const found = cases.find((entry) => entry.resourceType === resourceType)
  if (found === undefined) throw new Error(`no case for ${resourceType}`)
  return found
}

/**
 * An origin the endpoint paths are resolved against.
 *
 * @remarks
 * `defineSliceHttpClient` deliberately sets no `baseUrl` — endpoint paths are
 * absolute-path relative, resolved against the browser's origin at runtime. This
 * suite runs under node, where there is no ambient origin and a bare
 * `/fhir-r4/...` is an `InvalidUrl`, so the origin is supplied here. Naming it
 * is also what keeps the routing assertions honest: they check the path this
 * test put on the wire, not one a test environment happened to imply.
 */
const TEST_ORIGIN = 'http://fhir-r4.test'

/**
 * A stub `HttpClient` that records every request. It echoes the request payload
 * back as a 200 (so the client decodes a valid resource and the write
 * succeeds), unless `shouldFail` forces a `503 ServiceUnavailable`.
 */
const recordingHttpClientLayer = (
  records: Array<RecordedRequest>,
  shouldFail: (request: HttpClientRequest.HttpClientRequest) => boolean
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.mapRequest(
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
      }),
      HttpClientRequest.prependUrl(TEST_ORIGIN)
    )
  )

/**
 * Persist a batch over the real client + recording stub, returning the recorded
 * requests and the sink's reported failures. Retry backoff runs on `TestClock`
 * (a 2s virtual jump covers the 250 + 500 + 1000ms schedule), so failure paths
 * don't wait on the real clock.
 */
const runPersist = async (
  resources: ReadonlyArray<FhirResource>,
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
        persistResources(resources).pipe(Effect.provide(clientLayer))
      )
      yield* TestClock.adjust(Duration.seconds(2))
      return yield* Fiber.join(fiber)
    }).pipe(Effect.provide(TestContext.TestContext))
  )
  return { records, failures }
}
