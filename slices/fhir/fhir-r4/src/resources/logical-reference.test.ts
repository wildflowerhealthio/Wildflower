import { Option, Schema } from 'effect'
import { describe, expect, expectTypeOf, it } from 'vite-plus/test'

import {
  IdentifierSchema,
  isQualifiedIdentifier,
  type QualifiedIdentifierType,
  ReferenceSchema,
} from '../data-types/complex/identifier-and-reference.ts'
import type { FhirResource } from './fhir-resource.ts'
import * as LogicalReference from './logical-reference.ts'

/**
 * Covers the logical reference: the slice of a keyed resource a reference
 * names it by, read off a reference or an identifier, and keyed by type,
 * system and value alone.
 */

const decodeIdentifier = Schema.decodeUnknownSync(IdentifierSchema)
const decodeReference = Schema.decodeUnknownSync(ReferenceSchema)

/** The qualified identifier `wire` decodes to. */
const qualified = (wire: typeof IdentifierSchema.Encoded): QualifiedIdentifierType => {
  const identifier = decodeIdentifier(wire)
  if (!isQualifiedIdentifier(identifier)) {
    throw new Error('unreachable: the wire has a system and a value')
  }
  return identifier
}

const SYSTEM = 'https://portal.example/patient-id'

const PATIENT_KEY = qualified({ system: SYSTEM, value: 'pat-7' })

describe('LogicalReference', () => {
  it('is a slice of a keyed resource: its type and its one identifier', () => {
    expectTypeOf<LogicalReference.Type<'Patient'>>().toExtend<
      Pick<
        Extract<FhirResource, { readonly resourceType: 'Patient' }>,
        'resourceType' | 'identifier'
      >
    >()
    expect(LogicalReference.make('Patient', PATIENT_KEY)).toEqual({
      resourceType: 'Patient',
      identifier: [PATIENT_KEY],
    })
  })
})

describe('LogicalReference.key', () => {
  it('spells the type, system and value, and nothing else the identifier says', () => {
    const described = qualified({
      system: SYSTEM,
      value: 'pat-7',
      use: 'official',
      type: { text: 'Patient portal id' },
      period: { start: '2020-01-01' },
    })

    expect(LogicalReference.key(LogicalReference.make('Patient', described))).toBe(
      LogicalReference.key(LogicalReference.make('Patient', PATIENT_KEY))
    )
    expect(
      LogicalReference.equivalence(
        LogicalReference.make('Patient', described),
        LogicalReference.make('Patient', PATIENT_KEY)
      )
    ).toBe(true)
  })

  it('tells apart another type, system or value', () => {
    const keys = [
      LogicalReference.make('Patient', PATIENT_KEY),
      LogicalReference.make('Practitioner', PATIENT_KEY),
      LogicalReference.make(
        'Patient',
        qualified({ system: 'https://other.example/id', value: 'pat-7' })
      ),
      LogicalReference.make('Patient', qualified({ system: SYSTEM, value: 'pat-8' })),
    ].map(LogicalReference.key)

    expect(new Set(keys).size).toBe(keys.length)
  })

  // A system may carry the character a naive `<Type>|<system>|<value>` join
  // would split on: `https://a.example/x|y` and `y|z` would spell alike.
  it('tells apart identifiers that only a separator inside a system or value would join', () => {
    const joinedAtSystem = qualified({ system: 'https://a.example/x|y', value: 'z' })
    const joinedAtValue = qualified({ system: 'https://a.example/x', value: 'y|z' })

    expect(LogicalReference.key(LogicalReference.make('Patient', joinedAtSystem))).not.toBe(
      LogicalReference.key(LogicalReference.make('Patient', joinedAtValue))
    )
  })
})

describe('LogicalReference.Key', () => {
  it('is a string, and no string is one', () => {
    expectTypeOf<LogicalReference.Key>().toExtend<string>()
    expectTypeOf<string>().not.toExtend<LogicalReference.Key>()
    expectTypeOf(LogicalReference.key).returns.toEqualTypeOf<LogicalReference.Key>()
  })
})

describe('LogicalReference.tryFromIdentifier', () => {
  it('makes the logical reference a qualified identifier makes, and none from an unqualified one', () => {
    expect([
      LogicalReference.tryFromIdentifier('Patient', PATIENT_KEY),
      LogicalReference.tryFromIdentifier('Patient', decodeIdentifier({ value: 'pat-7' })),
      LogicalReference.tryFromIdentifier('Patient', decodeIdentifier({ system: SYSTEM })),
    ]).toEqual([
      Option.some(LogicalReference.make('Patient', PATIENT_KEY)),
      Option.none(),
      Option.none(),
    ])
  })
})

describe('LogicalReference.tryFromReference', () => {
  it('reads the type and identifier of a logical reference, a type this package does not model included', () => {
    expect([
      LogicalReference.tryFromReference(
        decodeReference({ type: 'Patient', identifier: { system: SYSTEM, value: 'pat-7' } })
      ),
      LogicalReference.tryFromReference(
        decodeReference({ type: 'Organization', identifier: { system: SYSTEM, value: 'org-1' } })
      ),
    ]).toEqual([
      Option.some(LogicalReference.make('Patient', PATIENT_KEY)),
      Option.some(
        LogicalReference.make('Organization', qualified({ system: SYSTEM, value: 'org-1' }))
      ),
    ])
  })

  it.each([
    {
      name: 'a literal',
      wire: {
        reference: 'Patient/1',
        type: 'Patient',
        identifier: { system: SYSTEM, value: 'pat-7' },
      },
    },
    { name: 'an untyped identifier', wire: { identifier: { system: SYSTEM, value: 'pat-7' } } },
    { name: 'a display alone', wire: { type: 'Patient', display: 'Tyra Banks' } },
    {
      name: 'an identifier with no system',
      wire: { type: 'Patient', identifier: { value: 'pat-7' } },
    },
    {
      name: 'a type R4 does not define',
      wire: { type: 'Pet', identifier: { system: SYSTEM, value: 'pat-7' } },
    },
  ])('reads nothing off $name', ({ wire }) => {
    expect(LogicalReference.tryFromReference(decodeReference(wire))).toEqual(Option.none())
  })
})
