import { localResourceId } from '@wildflowerhealthio/fhir-r4/identity'
import {
  Binary,
  CarePlan,
  DiagnosticReport,
  DocumentReference,
  type FhirResource,
  FhirResourceSchema,
  Goal,
  ImagingStudy,
  MedicationDispense,
  MedicationRequest,
  Observation,
  Patient,
  PlanDefinition,
  Practitioner,
  Procedure,
  ServiceRequest,
} from '@wildflowerhealthio/fhir-r4/resources'
import { Arbitrary, FastCheck as fc, Schema } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import { adoptResource, originalIdOf, type SourceIdentity } from './adopt-resource.ts'
import * as DecodedId from './decoded-id.ts'

/**
 * Covers the id a decoded resource is adopted under: its own when it has one,
 * and a digest of its content when it has none — the same for the same record
 * however its source ordered its fields or stamped its `meta`, different for
 * different content — and that a generated id is recorded as no source
 * identifier.
 */

const SOURCE: SourceIdentity = {
  system: 'https://source.example/baseR4',
  baseUrl: 'https://source.example/baseR4',
}

const adopt = adoptResource(SOURCE)

/** One deterministic, schema-valid resource of the given type, with no id. */
const sampleWithoutId = <A extends FhirResource, I>(
  schema: Schema.Schema<A, I>,
  seed: number
): A => {
  const [value] = fc.sample(Arbitrary.make(schema), { numRuns: 1, seed })
  if (value === undefined) throw new Error('unreachable: one sample requested')
  return { ...value, id: null }
}

/** One generated, id-less resource per type in the closed union. */
const idLessResources: readonly FhirResource[] = [
  sampleWithoutId(Binary.Schema, 11),
  sampleWithoutId(Patient.Schema, 12),
  sampleWithoutId(Observation.Schema, 13),
  sampleWithoutId(MedicationRequest.Schema, 14),
  sampleWithoutId(MedicationDispense.Schema, 15),
  sampleWithoutId(DocumentReference.Schema, 16),
  sampleWithoutId(DiagnosticReport.Schema, 17),
  sampleWithoutId(Practitioner.Schema, 18),
  sampleWithoutId(ServiceRequest.Schema, 19),
  sampleWithoutId(ImagingStudy.Schema, 20),
  sampleWithoutId(CarePlan.Schema, 21),
  sampleWithoutId(Goal.Schema, 22),
  sampleWithoutId(PlanDefinition.Schema, 23),
  sampleWithoutId(Procedure.Schema, 24),
]

const encode = Schema.encodeSync(FhirResourceSchema)
const decode = Schema.decodeUnknownSync(FhirResourceSchema)

/** `resource` decoded afresh off its wire form with `meta` replaced. */
const withMeta = (resource: FhirResource, meta: unknown): FhirResource =>
  decode({ ...encode(resource), meta })

describe('DecodedId.of', () => {
  test("is the resource's own id when it has one", () => {
    const patient = { ...sampleWithoutId(Patient.Schema, 12), id: 'src-1' }
    expect(DecodedId.of(patient)).toMatchObject({ _tag: 'FoundInSource', value: 'src-1' })
  })

  for (const resource of idLessResources) {
    const { resourceType } = resource

    test(`${resourceType}: is generated from the content of a resource with no id`, () => {
      const decodedId = DecodedId.of(resource)
      expect(decodedId._tag).toBe('GeneratedFromContent')
      expect(decodedId.value).toMatch(/^[0-9a-f]{16}$/)
    })

    test(`${resourceType}: is the same for the same content sent in another key order`, () => {
      const reordered = Object.fromEntries(Object.entries(encode(resource)).toReversed())
      expect(DecodedId.of(decode(reordered))).toEqual(DecodedId.of(resource))
    })

    test(`${resourceType}: is the same whatever meta the response stamped`, () => {
      const first = withMeta(resource, { versionId: '1', lastUpdated: '2026-01-01T00:00:00Z' })
      const second = withMeta(resource, { versionId: '7', lastUpdated: '2026-09-30T12:00:00Z' })
      expect(DecodedId.of(second)).toEqual(DecodedId.of(first))
    })

    test(`${resourceType}: is recorded as no source identifier on adoption`, () => {
      const adopted = adopt(resource)
      expect(adopted.id).toBe(
        localResourceId(SOURCE.system, resourceType, DecodedId.of(resource).value)
      )
      expect(adopted.id).not.toBe(adopt({ ...resource, id: 'src-1' }).id)
      // The source gave it no id, so nothing claims one: it keeps exactly the
      // identifiers it arrived with, and no source id reads back off it.
      if ('identifier' in adopted && 'identifier' in resource) {
        expect(adopted.identifier).toEqual(resource.identifier)
      }
      expect(originalIdOf(SOURCE, adopted)).toBeNull()
    })
  }

  test('differs for two resources of different content', () => {
    const observation = sampleWithoutId(Observation.Schema, 13)
    const another = sampleWithoutId(Observation.Schema, 14)
    expect(another).not.toEqual(observation)
    expect(DecodedId.of(another)).not.toEqual(DecodedId.of(observation))
  })
})
