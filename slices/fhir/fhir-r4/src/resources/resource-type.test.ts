import type * as FhirR4 from 'fhir/r4.d.ts'
import { describe, expect, expectTypeOf, it } from 'vite-plus/test'

import type { FhirResource } from './fhir-resource.ts'
import * as ResourceType from './resource-type.ts'

describe('ResourceType', () => {
  it('holds every type the resource union models', () => {
    expectTypeOf<FhirResource['resourceType']>().toExtend<ResourceType.Type>()
  })

  // `@types/fhir`'s union leaves out `AdverseEvent`, which R4 defines; every
  // type it does list is in the value set.
  it("holds every type @types/fhir's R4 union lists", () => {
    expectTypeOf<FhirR4.FhirResource['resourceType']>().toExtend<ResourceType.Type>()
    expect(ResourceType.is('AdverseEvent')).toBe(true)
  })

  it('names every R4 resource type, a type this package does not model included', () => {
    expect(ResourceType.VALUES).toHaveLength(146)
    expect(ResourceType.is('Encounter')).toBe(true)
    expect(ResourceType.is('Patient')).toBe(true)
  })

  it('names no type R4 does not define, nor an abstract one', () => {
    for (const token of ['PrescriptionOrder', 'rexall-pharmacy-location', 'Resource', 'patient']) {
      expect(ResourceType.is(token)).toBe(false)
    }
  })
})
