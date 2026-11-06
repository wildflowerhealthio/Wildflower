import {
  type FhirResource,
  FhirResourceSchema,
  Patient,
} from '@wildflowerhealthio/fhir-r4/resources'
import { Arbitrary, Array as Arr, FastCheck as fc, Schema } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import * as DetachedResource from './detached-resource.ts'

/**
 * The resource types of the union FHIR R4 defines no `identifier` element
 * for, from the R4 resource definitions: what `hasIdentifier` must answer
 * `false` for, and nothing else.
 */
const TYPES_WITHOUT_IDENTIFIER: ReadonlySet<FhirResource['resourceType']> = new Set(['Binary'])

const encodeResource = Schema.encodeSync(FhirResourceSchema)
const decodeResource = Schema.decodeUnknownSync(FhirResourceSchema)

/** `wire` with its `identifier` element left out. */
const withoutIdentifier = (wire: object): Record<string, unknown> =>
  Object.fromEntries(Object.entries(wire).filter(([element]) => element !== 'identifier'))

/**
 * One resource of each type in the union, decoded from wire that leaves
 * `identifier` out: what a decoder that writes none gets back. Sampled from
 * the union's own arbitrary, enough runs (seeded) that every member shows up;
 * the first test pins that it does.
 */
const resourcesWrittenWithoutIdentifier: readonly FhirResource[] = Object.values(
  Arr.groupBy(
    fc.sample(Arbitrary.make(FhirResourceSchema), { numRuns: 200, seed: 7 }),
    ({ resourceType }) => resourceType
  )
).map(([sampled]) => decodeResource(withoutIdentifier(encodeResource(sampled))))

describe('hasIdentifier', () => {
  test('the sweep holds one resource of each type in the union', () => {
    const sweptTypes = new Set(
      resourcesWrittenWithoutIdentifier.map(({ resourceType }) => resourceType)
    )
    expect(sweptTypes.size).toBe(FhirResourceSchema.members.length)
  })

  for (const resource of resourcesWrittenWithoutIdentifier) {
    const { resourceType } = resource
    const hasElement = !TYPES_WITHOUT_IDENTIFIER.has(resourceType)

    test(`${resourceType}: ${hasElement ? 'has' : 'lacks'} the element, as R4 defines it`, () => {
      expect(DetachedResource.hasIdentifier(resource)).toBe(hasElement)
    })

    if (hasElement) {
      // The claim `hasIdentifier` rests on: the schema defaults the element,
      // so a decoded resource of the type carries it even when its wire left
      // it out.
      test(`${resourceType}: the schema defaults the element to []`, () => {
        expect(Object.entries(resource)).toContainEqual(['identifier', []])
      })
    }
  }
})

describe('decodeUnknownEither', () => {
  const decodePatient = DetachedResource.decodeUnknownEither(Patient.Schema)

  test('decodes a detached record, and fails one with an id or one the schema rejects', () => {
    expect(decodePatient({ resourceType: 'Patient', name: [{ text: 'Tyra Banks' }] })._tag).toBe(
      'Right'
    )
    expect(decodePatient({ resourceType: 'Patient', id: 'p-1' })._tag).toBe('Left')
    expect(decodePatient({ resourceType: 'Patient', gender: 'dragon' })._tag).toBe('Left')
  })
})
