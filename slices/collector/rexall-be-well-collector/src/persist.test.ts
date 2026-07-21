import { HttpClient, type HttpClientRequest, HttpClientResponse } from '@effect/platform'
import type { CollectorDescriptor } from 'collector-fundamentals/model'
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
import { FhirR4ResourcesHttpApiClient, UnsupportedFhirResourceTypeError } from 'fhir-r4/clients'
import {
  Binary,
  type FhirResource,
  MedicationDispense,
  MedicationRequest,
  Observation,
  Patient,
} from 'fhir-r4/resources'
import { describe, expect, it } from 'vite-plus/test'

import { describeResource, persistResources } from './persist.ts'

/**
 * Covers the Rexall persist sink (a verbatim copy of the FHIR R4 sink): a batch
 * routes each resource type to *its* `Update` endpoint via `upsertResource`, and
 * a resource still failing after its retries comes back as a
 * {@link CollectorDescriptor.PersistFailure} while the batch Effect itself never
 * fails. Driven over the real `FhirR4ResourcesHttpApiClient` layer against a
 * recording stub `HttpClient`, with retry backoff on `TestClock`.
 */

describe('persistResources', () => {
  for (const { resourceType, make } of cases) {
    it(`routes ${resourceType} to PUT /fhir-r4/${resourceType}/<id>`, async () => {
      const id = `${resourceType}-1`
      const { records, failures } = await runPersist([make(id)])
      expect(failures).toEqual([])
      expect(records).toHaveLength(1)
      expect(records[0].method).toBe('PUT')
      expect(records[0].url).toContain(`/fhir-r4/${resourceType}/${id}`)
    })
  }

  it('skips a null-id resource without issuing any write, reporting no failure', async () => {
    const { records, failures } = await runPersist([cases[0].make(null)])
    expect(records).toEqual([])
    expect(failures).toEqual([])
  })

  it('reports a resource still failing after its retries as a PersistFailure, having retried it', async () => {
    const { records, failures } = await runPersist([cases[0].make('boom-1')], () => true)
    // One initial attempt + three retries.
    expect(records).toHaveLength(4)
    expect(failures).toHaveLength(1)
    expect(failures[0].failed).toEqual({ label: 'Patient', id: 'boom-1' })
    expect(failures[0].cause).toBeDefined()
  })

  it('does not let one failed resource fail the rest of the batch', async () => {
    const good = byType('MedicationRequest').make('ok-1')
    const bad = byType('MedicationDispense').make('bad-1')
    const { failures } = await runPersist([good, bad], (request) =>
      request.url.includes('/MedicationDispense/')
    )
    expect(failures).toHaveLength(1)
    expect(failures[0].failed).toEqual({ label: 'MedicationDispense', id: 'bad-1' })
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
    expect(failures[0].failed).toEqual({ label: 'Practitioner', id: 'p-1' })
    expect(failures[0].cause).toBeInstanceOf(UnsupportedFhirResourceTypeError)
  })
})

describe('describeResource', () => {
  it('labels a resource by its FHIR resourceType and id', () => {
    const request = byType('MedicationRequest').make('mr-1')
    expect(describeResource(request)).toEqual({ label: 'MedicationRequest', id: 'mr-1' })
  })

  it('falls back to a sentinel id for a null-id resource', () => {
    const binary = byType('Binary').make(null)
    expect(describeResource(binary)).toEqual({ label: 'Binary', id: '<no-id>' })
  })
})

// Helpers

interface RecordedRequest {
  readonly method: string
  readonly url: string
}

const genWithId = <A extends FhirResource, I>(
  schema: Schema.Schema<A, I>,
  id: string | null
): FhirResource => {
  const value = fc.sample(Arbitrary.make(schema), { numRuns: 1, seed: 7 })[0]
  return { ...value, id }
}

const cases: ReadonlyArray<{
  readonly resourceType: FhirResource['resourceType']
  readonly make: (id: string | null) => FhirResource
}> = [
  { resourceType: 'Patient', make: (id) => genWithId(Patient.Schema, id) },
  { resourceType: 'Observation', make: (id) => genWithId(Observation.Schema, id) },
  { resourceType: 'Binary', make: (id) => genWithId(Binary.Schema, id) },
  { resourceType: 'MedicationRequest', make: (id) => genWithId(MedicationRequest.Schema, id) },
  { resourceType: 'MedicationDispense', make: (id) => genWithId(MedicationDispense.Schema, id) },
]

const byType = (resourceType: FhirResource['resourceType']): (typeof cases)[number] =>
  cases.find((c) => c.resourceType === resourceType)!

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
