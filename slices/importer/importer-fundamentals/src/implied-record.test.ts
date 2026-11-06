import { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { LogicalReference } from '@wildflowerhealthio/fhir-r4/resources'
import { Either, Option, Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import * as ImpliedRecord from './implied-record.ts'

/**
 * Covers the implied record: what a logical reference and its display imply
 * for each type, and the key its row is reviewed under.
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
  it.each(['Patient', 'Practitioner'] as const)(
    'implies a %s keyed by the identifier and named by the display',
    (resourceType) => {
      const implied = ImpliedRecord.tryFromLogicalReference(
        LogicalReference.make(resourceType, SMITH),
        'DR A SMITH'
      ).pipe(Option.map(Either.getOrThrow))

      expect(
        Option.map(implied, (record) =>
          record.resourceType === 'Patient' || record.resourceType === 'Practitioner'
            ? {
                resourceType: record.resourceType,
                id: record.id,
                identifier: record.identifier.map(({ system, value }) => [system?.href, value]),
                name: record.name.map(({ text }) => text),
              }
            : record
        )
      ).toEqual(
        Option.some({
          resourceType,
          id: null,
          identifier: [[SYSTEM, 'Dr. A Smith']],
          name: ['DR A SMITH'],
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

describe('ImpliedRecord.fullUrlOf', () => {
  it('keys the record by the referencing fullUrl and the logical reference, one per target', () => {
    expect([
      ImpliedRecord.fullUrlOf('rx:0', LogicalReference.make('Practitioner', SMITH)),
      ImpliedRecord.fullUrlOf('rx:0', LogicalReference.make('Patient', SMITH)),
      ImpliedRecord.fullUrlOf('rx:1', LogicalReference.make('Practitioner', SMITH)),
    ]).toEqual([
      `rx:0#implied:Practitioner|${SYSTEM}|Dr. A Smith`,
      `rx:0#implied:Patient|${SYSTEM}|Dr. A Smith`,
      `rx:1#implied:Practitioner|${SYSTEM}|Dr. A Smith`,
    ])
  })
})
