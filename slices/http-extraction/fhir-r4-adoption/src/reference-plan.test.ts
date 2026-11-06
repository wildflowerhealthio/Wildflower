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
