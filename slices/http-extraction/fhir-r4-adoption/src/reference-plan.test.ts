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
