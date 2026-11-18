import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { LogicalReference, ResourceType } from '@wildflowerhealthio/fhir-r4/resources'
import { Either, Option, Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import * as ImpliedRecord from './implied-record.ts'
import * as ResourcePlan from './resource-plan.ts'

/**
 * Covers the implied record: what a logical reference and its display imply
 * for each type, that each is keyed by the reference's identifier, and the
 * local key its row is reviewed under.
 */

const SYSTEM = 'https://pharmacy.example/practitioner-name'

/** The qualified identifier `{ system, value }`. */
const qualified = (
  system: string,
  value: string
): IdentifierAndReference.QualifiedIdentifierType => {
  const identifier = Schema.decodeUnknownSync(IdentifierAndReference.IdentifierSchema)({
    system,
    value,
  })
  if (!IdentifierAndReference.isQualifiedIdentifier(identifier)) {
    throw new Error('unreachable: the wire has a system and a value')
  }
  return identifier
}

const SMITH = qualified(SYSTEM, 'Dr. A Smith')

describe('ImpliedRecord.tryFromLogicalReference', () => {
  it.each([
    {
      resourceType: 'Patient',
      display: 'DR A SMITH',
      name: { text: 'DR A SMITH', family: null, given: [] },
    },
    {
      resourceType: 'Practitioner',
      display: 'DR A SMITH',
      name: { text: 'DR A SMITH', family: 'SMITH', given: ['A'] },
    },
    {
      resourceType: 'Practitioner',
      display: 'OSEI DR. KWAME',
      name: { text: 'OSEI DR. KWAME', family: 'OSEI', given: ['KWAME'] },
    },
    {
      resourceType: 'Practitioner',
      display: 'Dr.',
      name: { text: 'Dr.', family: null, given: [] },
    },
  ] as const)(
    'implies a $resourceType keyed by the identifier, named $name.text with family $name.family',
    ({ resourceType, display, name }) => {
      const implied = ImpliedRecord.tryFromLogicalReference(
        LogicalReference.make(resourceType, SMITH),
        display
      ).pipe(Option.map(Either.getOrThrow))

      expect(
        Option.map(implied, (record) =>
          record.resourceType === 'Patient' || record.resourceType === 'Practitioner'
            ? {
                resourceType: record.resourceType,
                id: record.id,
                identifier: record.identifier.map(({ system, value }) => [system?.href, value]),
                name: record.name.map(({ text, family, given, prefix, suffix }) => ({
                  text,
                  family,
                  given,
                  prefix,
                  suffix,
                })),
              }
            : record
        )
      ).toEqual(
        Option.some({
          resourceType,
          id: null,
          identifier: [[SYSTEM, 'Dr. A Smith']],
          name: [{ ...name, prefix: [], suffix: [] }],
        })
      )
    }
  )

  it.each([
    { name: 'a type whose record needs more than a reference says', resourceType: 'Observation' },
    { name: 'a type fhir-r4 does not model', resourceType: 'Organization' },
  ] as const)('implies nothing for $name', ({ resourceType }) => {
    expect(
      ImpliedRecord.tryFromLogicalReference(LogicalReference.make(resourceType, SMITH), 'Anyone')
    ).toEqual(Option.none())
  })
})

describe('ImpliedRecord.tryFromLogicalReference, over every type a reference implies a record of', () => {
  // Every R4 type, so every type the registry gives a maker is among them.
  const implied = ResourceType.VALUES.flatMap((resourceType) =>
    Option.toArray(
      Option.map(
        ImpliedRecord.tryFromLogicalReference(
          LogicalReference.make(resourceType, SMITH),
          'DR A SMITH'
        ),
        (record) => ({ resourceType, record: Either.getOrThrow(record) })
      )
    )
  )

  it('finds some type a reference implies a record of', () => {
    expect(implied.length).toBeGreaterThan(0)
  })

  // The import stage plans an implied record from the reference that implies
  // it (`ResourcePlan.derived`), so the record has to be keyed by exactly
  // that reference's identifier.
  it.each(implied.map(({ resourceType, record }) => [resourceType, record] as const))(
    'keys the %s it implies by the identifier of the reference that implies it',
    (resourceType, record) => {
      const key = DetachedResource.keyIdentifierOf(record)
      expect(record.resourceType).toBe(resourceType)
      expect(Option.map(key, ({ system, value }) => [system.href, value])).toEqual(
        Option.some([SMITH.system.href, SMITH.value])
      )
      expect(ResourcePlan.make(record, () => 'unused')).toEqual(
        ResourcePlan.derived(record.resourceType, SMITH)
      )
    }
  )
})

describe('ImpliedRecord.localKeyOf', () => {
  it('keys the record by the referencing local key and the logical reference, one per target', () => {
    expect([
      ImpliedRecord.localKeyOf('rx:0', LogicalReference.make('Practitioner', SMITH)),
      ImpliedRecord.localKeyOf('rx:0', LogicalReference.make('Patient', SMITH)),
      ImpliedRecord.localKeyOf('rx:1', LogicalReference.make('Practitioner', SMITH)),
    ]).toEqual([
      `rx:0#implied:Practitioner|${SYSTEM}|Dr. A Smith`,
      `rx:0#implied:Patient|${SYSTEM}|Dr. A Smith`,
      `rx:1#implied:Practitioner|${SYSTEM}|Dr. A Smith`,
    ])
  })
})
