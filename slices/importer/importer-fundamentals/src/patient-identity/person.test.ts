import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { FastCheck as fc } from 'effect'
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test'

import * as Person from './person.ts'
import {
  decodePatient,
  identifierKeys,
  patientArbitrary,
  person,
  personArbitrary,
  wireOf,
} from './test-resources.ts'

// Schema-generated resources at fast-check's default size run to hundreds of
// kilobytes each; the properties are about structure, which the smallest size
// still exercises.
beforeAll(() => {
  fc.configureGlobal({ baseSize: 'xsmall' })
})
afterAll(() => {
  fc.resetConfigureGlobal()
})

describe('Person.mergeSourceIdentifiers', () => {
  it('appends the identifiers the target does not carry, after its own', () => {
    const target = person('p', [{ system: 'https://a.example/id', value: '1' }])
    const source = decodePatient({
      resourceType: 'Patient',
      identifier: [
        { system: 'https://a.example/id', value: '1' },
        { system: 'https://b.example/id', value: '2' },
      ],
    })

    expect(
      identifierKeys(Person.mergeSourceIdentifiers({ person: target, sourcePatient: source }))
    ).toEqual(['https://a.example/id|1', 'https://b.example/id|2'])
  })

  it('property: is idempotent', () => {
    fc.assert(
      fc.property(personArbitrary, patientArbitrary, (target, source) => {
        const once = Person.mergeSourceIdentifiers({ person: target, sourcePatient: source })
        expect(wireOf(Person.mergeSourceIdentifiers({ person: once, sourcePatient: source }))).toBe(
          wireOf(once)
        )
      }),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })

  it('property: keeps the identifiers a set by system + value', () => {
    fc.assert(
      fc.property(personArbitrary, patientArbitrary, (target, source) => {
        const keys = identifierKeys(
          Person.mergeSourceIdentifiers({ person: target, sourcePatient: source })
        )
        expect(new Set(keys).size).toBe(keys.length)
        expect(new Set(keys)).toEqual(
          new Set([...identifierKeys(target), ...identifierKeys(source)])
        )
      }),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })

  it("property: leaves the target's demographics byte-identical", () => {
    fc.assert(
      fc.property(personArbitrary, patientArbitrary, (target, source) => {
        const merged = Person.mergeSourceIdentifiers({ person: target, sourcePatient: source })
        expect(wireOf({ ...merged, identifier: [] })).toBe(wireOf({ ...target, identifier: [] }))
      }),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })
})
