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
import * as IdSpace from './id-space.ts'

/**
 * Covers the id a decoded resource is adopted under: its own when it has one,
 * and a digest of its content when it has none — the same for the same record
 * however its source ordered its fields or stamped its `meta`, different for
 * different content or a different source — and that a generated id is keyed
 * and recorded in the content-digest id space.
 */

const BASE = 'https://source.example/baseR4'

const SOURCE: SourceIdentity = { system: BASE, baseUrl: BASE }

const adopt = adoptResource(SOURCE)

const SCOPE = `${BASE}/Patient`

/** `DecodedId.of` scoped as {@link SOURCE} scopes `resource`'s type. */
const decodedIdOf = (resource: FhirResource): DecodedId.Type =>
  DecodedId.of(`${BASE}/${resource.resourceType}`, resource)

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
    expect(DecodedId.of(SCOPE, patient)).toMatchObject({ _tag: 'FoundInSource', value: 'src-1' })
  })

  for (const resource of idLessResources) {
    const { resourceType } = resource

    test(`${resourceType}: is generated from the content of a resource with no id`, () => {
      const decodedId = decodedIdOf(resource)
      expect(decodedId._tag).toBe('GeneratedFromContent')
      expect(decodedId.value).toMatch(/^[0-9a-f]{16}$/)
    })

    test(`${resourceType}: is the same for the same content sent in another key order`, () => {
      const reordered = Object.fromEntries(Object.entries(encode(resource)).toReversed())
      expect(decodedIdOf(decode(reordered))).toEqual(decodedIdOf(resource))
    })

    test(`${resourceType}: is the same whatever meta the response stamped`, () => {
      const first = withMeta(resource, { versionId: '1', lastUpdated: '2026-01-01T00:00:00Z' })
      const second = withMeta(resource, { versionId: '7', lastUpdated: '2026-09-30T12:00:00Z' })
      expect(decodedIdOf(second)).toEqual(decodedIdOf(first))
    })

    test(`${resourceType}: is keyed and recorded in the content-digest id space`, () => {
      const adopted = adopt(resource)
      const digest = decodedIdOf(resource).value
      expect(adopted.id).toBe(localResourceId(IdSpace.CONTENT_DIGEST, resourceType, digest))
      expect(adopted.id).not.toBe(adopt({ ...resource, id: 'src-1' }).id)
      if ('identifier' in adopted && 'identifier' in resource) {
        expect(adopted.identifier[0]).toMatchObject({
          system: new URL(IdSpace.CONTENT_DIGEST),
          value: digest,
        })
        expect(adopted.identifier.slice(1)).toEqual(resource.identifier)
      }
      // The source knows it by no id, so no source id reads back off it.
      expect(originalIdOf(SOURCE, adopted)).toBeNull()
    })
  }

  test('differs for two resources of different content', () => {
    const observation = sampleWithoutId(Observation.Schema, 13)
    const another = sampleWithoutId(Observation.Schema, 14)
    expect(another).not.toEqual(observation)
    expect(decodedIdOf(another)).not.toEqual(decodedIdOf(observation))
  })

  test('differs for the same content from two sources', () => {
    const observation = sampleWithoutId(Observation.Schema, 13)
    expect(DecodedId.of('https://a.example/fhir/Observation', observation)).not.toEqual(
      DecodedId.of('https://b.example/fhir/Observation', observation)
    )
  })
})
