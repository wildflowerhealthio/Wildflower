import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Arbitrary, FastCheck as fc, Schema } from 'effect'
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test'

import { FhirResourceSchema, type FhirResource } from './fhir-resource.ts'
import {
  MedicationDispense,
  MedicationRequest,
  Observation,
  Patient,
  ResourceReferences,
} from './index.ts'

/**
 * The walk is checked against the wire form, an oracle independent of the
 * decoded-side schema check it finds references by.
 */

// Schema-generated resources at fast-check's default size run to hundreds of
// kilobytes each; the properties are about structure, which the smallest size
// still exercises.
beforeAll(() => {
  fc.configureGlobal({ baseSize: 'xsmall' })
})
afterAll(() => {
  fc.resetConfigureGlobal()
})

const encodeResource = Schema.encodeSync(FhirResourceSchema)
const decodeResource = Schema.decodeUnknownSync(FhirResourceSchema)

/** Generated resources of the types that carry references, with no `contained`. */
const resourceArbitrary: fc.Arbitrary<FhirResource> = fc.oneof(
  Arbitrary.make(Patient.Schema).map((patient): FhirResource => ({ ...patient, contained: [] })),
  Arbitrary.make(Observation.Schema).map((observation): FhirResource => ({
    ...observation,
    contained: [],
  })),
  Arbitrary.make(MedicationRequest.Schema).map((request): FhirResource => ({
    ...request,
    contained: [],
  })),
  Arbitrary.make(MedicationDispense.Schema).map((dispense): FhirResource => ({
    ...dispense,
    contained: [],
  }))
)

/** Every `reference` string the wire form of `resource` carries on a Reference-shaped object. */
const wireReferences = (resource: FhirResource): readonly string[] => {
  const found: string[] = []
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const element of value) visit(element)
    } else if (typeof value === 'object' && value !== null) {
      for (const [key, field] of Object.entries(value)) {
        if (key === 'reference' && typeof field === 'string') found.push(field)
        else visit(field)
      }
    }
  }
  visit(encodeResource(resource))
  return found
}

const FROM = 'Patient/wf-walk-from-0000'
const TO = 'Patient/wf-walk-to-0000'
/** The references a generated resource is re-spelled with, so matches are common. */
const REFERENCE_POOL = [FROM, 'Patient/wf-another-0000', 'Observation/wf-obs-0000'] as const

/** Generated resources whose every wire `reference` is drawn from {@link REFERENCE_POOL}. */
const pooledResourceArbitrary = fc
  .tuple(resourceArbitrary, fc.array(fc.constantFrom(...REFERENCE_POOL), { minLength: 1 }))
  .map(([resource, picks]) => {
    let next = 0
    const respell = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(respell)
      if (typeof value !== 'object' || value === null) return value
      return Object.fromEntries(
        Object.entries(value).map(([key, field]) => {
          if (key !== 'reference' || typeof field !== 'string') return [key, respell(field)]
          const pick = picks[next % picks.length]
          next += 1
          return [key, pick]
        })
      )
    }
    return decodeResource(respell(encodeResource(resource)))
  })

describe('ResourceReferences.collect', () => {
  it('property: finds every literal reference the wire form carries', () => {
    fc.assert(
      fc.property(resourceArbitrary, (resource) => {
        expect(
          ResourceReferences.collect(resource)
            .flatMap(({ reference }) => (reference === null ? [] : [reference]))
            .toSorted()
        ).toEqual(wireReferences(resource).toSorted())
      }),
      { numRuns: numRunsFor({ base: 20 }) }
    )
  })
})

describe('ResourceReferences.map', () => {
  it('property: rewrites exactly the references the rewrite changes', () => {
    fc.assert(
      fc.property(pooledResourceArbitrary, (resource) => {
        const rewritten = ResourceReferences.map(resource, (reference) =>
          reference.reference === FROM ? { ...reference, reference: TO } : reference
        )

        expect(wireReferences(rewritten)).toEqual(
          wireReferences(resource).map((reference) => (reference === FROM ? TO : reference))
        )
      }),
      { numRuns: numRunsFor({ base: 20 }) }
    )
  })

  it('property: a resource the rewrite changes nothing in comes back as itself', () => {
    fc.assert(
      fc.property(resourceArbitrary, (resource) => {
        expect(ResourceReferences.map(resource, (reference) => reference)).toBe(resource)
      }),
      { numRuns: numRunsFor({ base: 20 }) }
    )
  })
})
