import {
  Binary,
  type FhirResource,
  FhirResourceSchema,
  Patient,
} from '@wildflowerhealthio/fhir-r4/resources'
import { Arbitrary, Array as Arr, Effect, FastCheck as fc, Option, Schema } from 'effect'
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

describe('storedIdsOf', () => {
  const decodePatient = DetachedResource.decodeUnknown(Patient.Schema)
  const decodeBinary = DetachedResource.decodeUnknown(Binary.Schema)

  /** A detached Patient keyed by `key`. */
  const patientKeyedBy = (key: DetachedResource.Key): DetachedResource.Type =>
    Effect.runSync(
      decodePatient({
        resourceType: 'Patient',
        identifier: [DetachedResource.keyIdentifierWire(key)],
      })
    )

  const key = { system: 'https://portal.example/patient-id', value: 'pat-7' }
  const keyless = Effect.runSync(
    decodeBinary({ resourceType: 'Binary', contentType: 'text/plain' })
  )
  const storedIds = DetachedResource.storedIdsOf([patientKeyedBy(key), keyless])

  test('looks up a keyed record of the batch under the id and reference its key derives', () => {
    expect(DetachedResource.storedIdIfInBatch(storedIds, 'Patient', key)).toEqual(
      DetachedResource.keyedIdOf(patientKeyedBy(key))
    )
    expect(DetachedResource.storedReferenceIfInBatch(storedIds, 'Patient', key)).toEqual(
      Option.some(DetachedResource.storedReferenceOf('Patient', key))
    )
  })

  test('finds nothing for a key of another type or value, and holds no keyless record', () => {
    expect(DetachedResource.storedReferenceIfInBatch(storedIds, 'Practitioner', key)).toEqual(
      Option.none()
    )
    expect(
      DetachedResource.storedReferenceIfInBatch(storedIds, 'Patient', { ...key, value: 'pat-8' })
    ).toEqual(Option.none())
    expect(storedIds.size).toBe(1)
  })

  // A system may carry the character a naive `<Type>|<system>|<value>` join
  // would split on: `https://a.example/x|y` and `y|z` would spell alike.
  test('tells apart keys that only a separator inside a system or value would join', () => {
    const joinedAtSystem = { system: 'https://a.example/x|y', value: 'z' }
    const joinedAtValue = { system: 'https://a.example/x', value: 'y|z' }
    const batch = DetachedResource.storedIdsOf([patientKeyedBy(joinedAtSystem)])

    expect(
      Option.isSome(DetachedResource.storedIdIfInBatch(batch, 'Patient', joinedAtSystem))
    ).toBe(true)
    expect(DetachedResource.storedIdIfInBatch(batch, 'Patient', joinedAtValue)).toEqual(
      Option.none()
    )
  })
})
