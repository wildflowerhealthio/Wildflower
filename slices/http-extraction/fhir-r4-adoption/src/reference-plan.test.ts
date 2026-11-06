import { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { Option, Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import * as ReferencePlan from './reference-plan.ts'

/**
 * Covers the reference plan: the literal reference a type and qualified
 * identifier resolve to, matched on type, system and value alone, and
 * nothing for an identifier given two different literal references.
 */

/** The qualified identifier `wire` decodes to. */
const qualified = (
  wire: typeof IdentifierAndReference.IdentifierSchema.Encoded
): IdentifierAndReference.QualifiedIdentifierType => {
  const identifier = Schema.decodeUnknownSync(IdentifierAndReference.IdentifierSchema)(wire)
  if (!IdentifierAndReference.isQualifiedIdentifier(identifier)) {
    throw new Error('unreachable: the wire has a system and a value')
  }
  return identifier
}

const SYSTEM = 'https://portal.example/patient-id'

const PATIENT_KEY = qualified({ system: SYSTEM, value: 'pat-7' })

/** The plan with one entry: the Patient keyed by {@link PATIENT_KEY} resolves to `Patient/stored-7`. */
const patientPlan = (): ReferencePlan.Type =>
  ReferencePlan.of([
    { resourceType: 'Patient', identifier: PATIENT_KEY, literalReference: 'Patient/stored-7' },
  ])

describe('ReferencePlan.literalReferenceFor', () => {
  it('resolves a type and identifier the plan holds to its literal reference', () => {
    expect(ReferencePlan.literalReferenceFor(patientPlan(), 'Patient', PATIENT_KEY)).toEqual(
      Option.some('Patient/stored-7')
    )
  })

  it('resolves nothing for another type, system or value', () => {
    const plan = patientPlan()
    expect([
      ReferencePlan.literalReferenceFor(plan, 'Practitioner', PATIENT_KEY),
      ReferencePlan.literalReferenceFor(
        plan,
        'Patient',
        qualified({ system: 'https://other.example/patient-id', value: 'pat-7' })
      ),
      ReferencePlan.literalReferenceFor(
        plan,
        'Patient',
        qualified({ system: SYSTEM, value: 'pat-8' })
      ),
    ]).toEqual([Option.none(), Option.none(), Option.none()])
  })

  // As a FHIR conditional reference that matches several records: which one
  // is meant cannot be told, so the reference stays logical.
  it('resolves nothing for an identifier given two different literal references', () => {
    const plan = ReferencePlan.of([
      { resourceType: 'Patient', identifier: PATIENT_KEY, literalReference: 'Patient/stored-7' },
      { resourceType: 'Patient', identifier: PATIENT_KEY, literalReference: 'Patient/stored-8' },
    ])
    expect(ReferencePlan.literalReferenceFor(plan, 'Patient', PATIENT_KEY)).toEqual(Option.none())
  })

  it('resolves an identifier given the same literal reference twice', () => {
    const plan = ReferencePlan.of([
      { resourceType: 'Patient', identifier: PATIENT_KEY, literalReference: 'Patient/stored-7' },
      { resourceType: 'Patient', identifier: PATIENT_KEY, literalReference: 'Patient/stored-7' },
    ])
    expect(ReferencePlan.literalReferenceFor(plan, 'Patient', PATIENT_KEY)).toEqual(
      Option.some('Patient/stored-7')
    )
  })

  // A system may carry the character a naive `<Type>|<system>|<value>` join
  // would split on: `https://a.example/x|y` and `y|z` would spell alike.
  it('tells apart identifiers that only a separator inside a system or value would join', () => {
    const joinedAtSystem = qualified({ system: 'https://a.example/x|y', value: 'z' })
    const joinedAtValue = qualified({ system: 'https://a.example/x', value: 'y|z' })
    const plan = ReferencePlan.of([
      { resourceType: 'Patient', identifier: joinedAtSystem, literalReference: 'Patient/stored-7' },
    ])
    expect([
      ReferencePlan.literalReferenceFor(plan, 'Patient', joinedAtSystem),
      ReferencePlan.literalReferenceFor(plan, 'Patient', joinedAtValue),
    ]).toEqual([Option.some('Patient/stored-7'), Option.none()])
  })

  // A reference's identifier names its target by system and value; the rest
  // describes the identifier, and a reference rarely repeats it.
  it("matches on system and value alone, whatever the identifier's other fields say", () => {
    const describedKey = qualified({
      system: SYSTEM,
      value: 'pat-7',
      use: 'official',
      type: { text: 'Patient portal id' },
      period: { start: '2020-01-01' },
    })
    expect([
      ReferencePlan.literalReferenceFor(patientPlan(), 'Patient', describedKey),
      ReferencePlan.literalReferenceFor(
        ReferencePlan.of([
          {
            resourceType: 'Patient',
            identifier: describedKey,
            literalReference: 'Patient/stored-7',
          },
        ]),
        'Patient',
        PATIENT_KEY
      ),
    ]).toEqual([Option.some('Patient/stored-7'), Option.some('Patient/stored-7')])
  })
})

describe('ReferencePlan.literalReferenceIfResolved', () => {
  const decodeReference = Schema.decodeUnknownSync(IdentifierAndReference.ReferenceSchema)

  const resolved = (plan: ReferencePlan.Type, wire: unknown): Option.Option<string> =>
    ReferencePlan.literalReferenceIfResolved(plan, decodeReference(wire))

  it('resolves a logical reference by an R4 type and an identifier the plan holds', () => {
    expect(
      resolved(patientPlan(), { type: 'Patient', identifier: { system: SYSTEM, value: 'pat-7' } })
    ).toEqual(Option.some('Patient/stored-7'))
  })

  it.each([
    {
      name: 'one that already has a literal',
      wire: {
        reference: 'Patient/other',
        type: 'Patient',
        identifier: { system: SYSTEM, value: 'pat-7' },
      },
    },
    { name: 'one that states no type', wire: { identifier: { system: SYSTEM, value: 'pat-7' } } },
    {
      name: 'one whose type is not an R4 resource type',
      wire: { type: 'Pet', identifier: { system: SYSTEM, value: 'pat-7' } },
    },
    {
      name: 'an identifier with no system',
      wire: { type: 'Patient', identifier: { value: 'pat-7' } },
    },
    {
      name: 'an identifier the plan does not hold',
      wire: { type: 'Patient', identifier: { system: SYSTEM, value: 'pat-8' } },
    },
  ])('resolves nothing for $name', ({ wire }) => {
    expect(resolved(patientPlan(), wire)).toEqual(Option.none())
  })

  it('resolves nothing for an identifier given two different literal references', () => {
    const plan = ReferencePlan.of([
      { resourceType: 'Patient', identifier: PATIENT_KEY, literalReference: 'Patient/stored-7' },
      { resourceType: 'Patient', identifier: PATIENT_KEY, literalReference: 'Patient/stored-8' },
    ])
    expect(
      resolved(plan, { type: 'Patient', identifier: { system: SYSTEM, value: 'pat-7' } })
    ).toEqual(Option.none())
  })
})

describe('ReferencePlan.extend', () => {
  it('resolves as the plan of every entry, old and added, would', () => {
    const practitionerKey = qualified({ system: SYSTEM, value: 'dr-1' })
    const added = [
      {
        resourceType: 'Practitioner',
        identifier: practitionerKey,
        literalReference: 'Practitioner/p-1',
      },
      { resourceType: 'Patient', identifier: PATIENT_KEY, literalReference: 'Patient/other-7' },
    ]
    const extended = ReferencePlan.extend(patientPlan(), added)

    expect(ReferencePlan.literalReferenceFor(extended, 'Practitioner', practitionerKey)).toEqual(
      Option.some('Practitioner/p-1')
    )
    // Two different literal references for one key are as ambiguous added as given at once.
    expect(ReferencePlan.literalReferenceFor(extended, 'Patient', PATIENT_KEY)).toEqual(
      Option.none()
    )
    expect(extended).toEqual(
      ReferencePlan.of([
        { resourceType: 'Patient', identifier: PATIENT_KEY, literalReference: 'Patient/stored-7' },
        ...added,
      ])
    )
  })
})

describe('ReferencePlan.holds', () => {
  it('holds a type and identifier given once, or given two different literal references', () => {
    const ambiguous = ReferencePlan.of([
      { resourceType: 'Patient', identifier: PATIENT_KEY, literalReference: 'Patient/stored-7' },
      { resourceType: 'Patient', identifier: PATIENT_KEY, literalReference: 'Patient/stored-8' },
    ])

    expect([
      ReferencePlan.holds(patientPlan(), 'Patient', PATIENT_KEY),
      ReferencePlan.holds(ambiguous, 'Patient', PATIENT_KEY),
    ]).toEqual([true, true])
  })

  it('holds nothing for another type or value', () => {
    expect([
      ReferencePlan.holds(patientPlan(), 'Practitioner', PATIENT_KEY),
      ReferencePlan.holds(patientPlan(), 'Patient', qualified({ system: SYSTEM, value: 'pat-8' })),
    ]).toEqual([false, false])
  })
})

describe('ReferencePlan.logicalTargetIfLogical', () => {
  const decodeReference = Schema.decodeUnknownSync(IdentifierAndReference.ReferenceSchema)

  it('names the type and identifier of a logical reference', () => {
    expect(
      ReferencePlan.logicalTargetIfLogical(
        decodeReference({ type: 'Patient', identifier: { system: SYSTEM, value: 'pat-7' } })
      )
    ).toEqual(Option.some({ resourceType: 'Patient', identifier: PATIENT_KEY }))
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
      name: 'a type R4 does not define',
      wire: { type: 'Pet', identifier: { system: SYSTEM, value: 'pat-7' } },
    },
  ])('names nothing for $name', ({ wire }) => {
    expect(ReferencePlan.logicalTargetIfLogical(decodeReference(wire))).toEqual(Option.none())
  })
})
