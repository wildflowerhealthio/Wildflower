import { HttpClient, HttpClientResponse } from '@effect/platform'
import { Arbitrary, Effect, FastCheck as fc, Layer, type Schema } from 'effect'
import { FhirR4ResourcesHttpApiClient } from 'fhir-r4/clients'
import {
  Binary,
  MedicationDispense,
  MedicationRequest,
  Observation,
  Patient,
} from 'fhir-r4/resources'
import { describe, expect, it } from 'vite-plus/test'

import type { AnyResource } from './config.ts'
import { describeResource, persistResource } from './persist.ts'

/**
 * Pins the FHIR write routing that used to live as a `switch` in the sync
 * runner: each resource type must reach *its* client group's `Update`
 * endpoint (a `PUT /fhir-r4/<Type>/<id>`), keyed on the resource's id.
 *
 * Driven over the real `FhirR4ResourcesHttpApiClient` layer against a
 * recording stub `HttpClient` — cast-free. The stub captures each request
 * as it is issued (before any response), so the assertion only reads the
 * method + URL the routing produced; the canned response body is
 * irrelevant. Valid payloads come from each resource schema's arbitrary
 * (a fixed seed keeps them deterministic), since the client encodes the
 * payload before the request is sent.
 */

interface RecordedRequest {
  readonly method: string
  readonly url: string
}

/** One deterministic, schema-valid resource with a known (or null) id. */
const genWithId = <A extends AnyResource, I>(
  schema: Schema.Schema<A, I>,
  id: string | null
): AnyResource => {
  const value = fc.sample(Arbitrary.make(schema), { numRuns: 1, seed: 7 })[0]
  return { ...value, id }
}

/**
 * The registered resource types paired with a monomorphic maker over each
 * concrete schema — mirrors the persist switch so a missing arm shows up
 * as a missing case here.
 */
const cases: ReadonlyArray<{
  readonly resourceType: AnyResource['resourceType']
  readonly make: (id: string | null) => AnyResource
}> = [
  { resourceType: 'Patient', make: (id) => genWithId(Patient.Schema, id) },
  { resourceType: 'Observation', make: (id) => genWithId(Observation.Schema, id) },
  { resourceType: 'Binary', make: (id) => genWithId(Binary.Schema, id) },
  { resourceType: 'MedicationRequest', make: (id) => genWithId(MedicationRequest.Schema, id) },
  { resourceType: 'MedicationDispense', make: (id) => genWithId(MedicationDispense.Schema, id) },
]

/** A stub `HttpClient` that records every request and 200s with an empty body. */
const recordingHttpClientLayer = (
  records: Array<RecordedRequest>
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      records.push({ method: request.method, url: request.url })
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
        )
      )
    })
  )

const runPersist = async (resource: AnyResource): Promise<ReadonlyArray<RecordedRequest>> => {
  const records: Array<RecordedRequest> = []
  const clientLayer = FhirR4ResourcesHttpApiClient.layer.pipe(
    Layer.provide(recordingHttpClientLayer(records))
  )
  // `Effect.either`: the empty stub response won't decode as the resource,
  // so persist may error — the routing (already recorded) is all we assert.
  await Effect.runPromise(
    persistResource(resource).pipe(Effect.either, Effect.provide(clientLayer))
  )
  return records
}

describe('persistResource', () => {
  for (const { resourceType, make } of cases) {
    it(`routes ${resourceType} to PUT /fhir-r4/${resourceType}/<id>`, async () => {
      const id = `${resourceType}-1`
      const records = await runPersist(make(id))
      expect(records).toHaveLength(1)
      expect(records[0].method).toBe('PUT')
      expect(records[0].url).toContain(`/fhir-r4/${resourceType}/${id}`)
    })
  }

  it('skips a null-id resource without issuing any write', async () => {
    const records = await runPersist(cases[0].make(null))
    expect(records).toEqual([])
  })
})

describe('describeResource', () => {
  it('labels a resource by its FHIR resourceType and id', () => {
    const observation = cases.find((c) => c.resourceType === 'Observation')!.make('obs-1')
    expect(describeResource(observation)).toEqual({ kind: 'Observation', id: 'obs-1' })
  })

  it('falls back to a sentinel id for a null-id resource', () => {
    const binary = cases.find((c) => c.resourceType === 'Binary')!.make(null)
    expect(describeResource(binary)).toEqual({ kind: 'Binary', id: '<no-id>' })
  })
})
