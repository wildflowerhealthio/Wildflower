import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { Patient as StorePatient } from 'emr-core/livestore'

import * as Patient from './patient.ts'

// ---------------------------------------------------------------------------
// Decomposed wire-format proof.
//
// Round-tripping `Arbitrary.make(StorePatient.RowSchema)` walks the entire
// FHIR graph (Reference → Identifier, HumanName/Address/etc. each carrying
// Element). At default `numRuns: 100` that grew to many minutes per file.
//
// The wire-format proof is preserved by decomposing into one property per
// column: each iteration generates only that column's content (via
// `RowSchema.pick(field)`), spreads it into a fixed empty-shell patient, and
// encodes/decodes the WHOLE patient through `Patient.Schema` — so the
// fhir-r4 adapter is still exercised end-to-end. Generation cost is now
// O(field) per iteration instead of O(graph).
// ---------------------------------------------------------------------------

const samplePatient: typeof StorePatient.RowSchema.Type = {
  resourceType: 'Patient',
  id: 'test-id',
  meta: {
    versionId: '',
    lastUpdated: null,
    source: '',
    profile: [],
    security: [],
    tag: [],
  },
  implicitRules: new URL('http://a.aa/'),
  language: null,
  active: false,
  address: [],
  birthDate: null,
  communication: [],
  contact: [],
  deceasedBoolean: false,
  deceasedDateTime: null,
  gender: null,
  generalPractitioner: [],
  identifier: [],
  link: [],
  managingOrganization: null,
  maritalStatus: null,
  multipleBirthBoolean: false,
  multipleBirthInteger: null,
  name: [],
  photo: [],
  telecom: [],
  contained: [],
  extension: [],
  modifierExtension: [],
  text: null,
}

const roundTrip = (patient: typeof StorePatient.RowSchema.Type): void => {
  const fhir = Schema.encodeSync(Patient.Schema)(patient)
  const decoded = Schema.decodeSync(Patient.Schema)(fhir)
  expect(decoded).toSchemaEqual(StorePatient.RowSchema, patient)
}

const fieldArb = <const K extends keyof typeof StorePatient.RowSchema.Type>(
  field: K
): fc.Arbitrary<Pick<typeof StorePatient.RowSchema.Type, K>> =>
  // `Schema.Struct.pick` returns a struct whose Type is structurally
  // `Pick<T, K>` but written as a mapped type that TS can't reduce; widen
  // through `unknown` so the public signature stays clean.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see comment
  Arbitrary.make(StorePatient.RowSchema.pick(field)) as unknown as fc.Arbitrary<
    Pick<typeof StorePatient.RowSchema.Type, K>
  >

describe('FhirR4Patient', () => {
  test('encode-decode round-trip with Some(meta) and empty collections', () => {
    roundTrip(samplePatient)
  })

  test('property: name field round-trips', () => {
    fc.assert(
      fc.property(fieldArb('name'), (override) => roundTrip({ ...samplePatient, ...override }))
    )
  })

  test('property: address field round-trips', () => {
    fc.assert(
      fc.property(fieldArb('address'), (override) => roundTrip({ ...samplePatient, ...override }))
    )
  })

  test('property: telecom field round-trips', () => {
    fc.assert(
      fc.property(fieldArb('telecom'), (override) => roundTrip({ ...samplePatient, ...override }))
    )
  })

  test('property: identifier field round-trips', () => {
    fc.assert(
      fc.property(fieldArb('identifier'), (override) =>
        roundTrip({ ...samplePatient, ...override })
      )
    )
  })

  test('property: generalPractitioner field round-trips', () => {
    fc.assert(
      fc.property(fieldArb('generalPractitioner'), (override) =>
        roundTrip({ ...samplePatient, ...override })
      )
    )
  })

  test('property: photo field round-trips', () => {
    fc.assert(
      fc.property(fieldArb('photo'), (override) => roundTrip({ ...samplePatient, ...override }))
    )
  })

  test('property: link field round-trips', () => {
    fc.assert(
      fc.property(fieldArb('link'), (override) => roundTrip({ ...samplePatient, ...override }))
    )
  })

  test('property: communication field round-trips', () => {
    fc.assert(
      fc.property(fieldArb('communication'), (override) =>
        roundTrip({ ...samplePatient, ...override })
      )
    )
  })

  test('property: contact field round-trips', () => {
    fc.assert(
      fc.property(fieldArb('contact'), (override) => roundTrip({ ...samplePatient, ...override }))
    )
  })

  test('property: managingOrganization field round-trips', () => {
    fc.assert(
      fc.property(fieldArb('managingOrganization'), (override) =>
        roundTrip({ ...samplePatient, ...override })
      )
    )
  })

  test('property: maritalStatus field round-trips', () => {
    fc.assert(
      fc.property(fieldArb('maritalStatus'), (override) =>
        roundTrip({ ...samplePatient, ...override })
      )
    )
  })

  test('property: shell primitives round-trip', () => {
    const shellArb = Arbitrary.make(
      StorePatient.RowSchema.pick(
        'active',
        'birthDate',
        'deceasedBoolean',
        'deceasedDateTime',
        'gender',
        'multipleBirthBoolean',
        'multipleBirthInteger',
        'language',
        'implicitRules',
        'meta'
      )
    )
    fc.assert(fc.property(shellArb, (override) => roundTrip({ ...samplePatient, ...override })))
  })
})
