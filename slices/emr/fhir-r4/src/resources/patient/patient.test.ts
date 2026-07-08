import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { AnnotateArrayWithArbitrary, TimelessDateFromString } from 'kitchen-sink/schema'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import {
  Address,
  AdministrativeGender,
  Attachment,
  Code,
  CodeableConcept,
  ContactPoint,
  HumanName,
  IdentifierAndReference,
  Meta,
} from '../../data-types/index.ts'
import * as PatientCommunication from './patient-communication.ts'
import * as PatientContact from './patient-contact.ts'
import * as PatientLink from './patient-link.ts'
import * as Patient from './patient.ts'

// ---------------------------------------------------------------------------
// Decomposed wire-format proof.
//
// Round-tripping an arbitrary over the whole Patient schema walks the entire
// FHIR graph (Reference → Identifier, HumanName/Address/etc. each carrying
// Element). At default `numRuns: 100` that grew to many minutes per file.
//
// The wire-format proof is preserved by decomposing into one property per
// field: each iteration generates only that field's content (from the same
// component schema the Patient struct embeds), spreads it into a fixed
// empty-shell patient, and encodes/decodes the WHOLE patient through
// `Patient.Schema` — so the wire schema is still exercised end-to-end.
// Generation cost is O(field) per iteration instead of O(graph).
// ---------------------------------------------------------------------------

const samplePatient: typeof Patient.Schema.Type = {
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

const roundTrip = (patient: typeof Patient.Schema.Type): void => {
  const fhir = Schema.encodeSync(Patient.Schema)(patient)
  const decoded = Schema.decodeSync(Patient.Schema)(fhir)
  expect(decoded).toSchemaEqual(Patient.Schema, patient)
}

// Generates decoded values for a single Patient field from the same
// component schema the Patient struct embeds, keyed so the result can be
// spread straight over `samplePatient`.
const fieldArb = <const K extends keyof typeof Patient.Schema.Type, I>(
  field: K,
  schema: Schema.Schema<(typeof Patient.Schema.Type)[K], I, never>
): fc.Arbitrary<Pick<typeof Patient.Schema.Type, K>> =>
  Arbitrary.make(schema).map((value) => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the computed single-key record is `Pick<T, K>` by construction; TS can't reduce the mapped type through the generic key.
    return { [field]: value } as unknown as Pick<typeof Patient.Schema.Type, K>
  })

describe('FhirR4Patient', () => {
  test('encode-decode round-trip with Some(meta) and empty collections', () => {
    roundTrip(samplePatient)
  })

  test('property: name field round-trips', () => {
    fc.assert(
      fc.property(
        fieldArb(
          'name',
          Schema.Array(HumanName.Schema).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 }))
        ),
        (override) => roundTrip({ ...samplePatient, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: address field round-trips', () => {
    fc.assert(
      fc.property(
        fieldArb(
          'address',
          Schema.Array(Address.Schema).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 }))
        ),
        (override) => roundTrip({ ...samplePatient, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: telecom field round-trips', () => {
    fc.assert(
      fc.property(
        fieldArb(
          'telecom',
          Schema.Array(ContactPoint.Schema).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 }))
        ),
        (override) => roundTrip({ ...samplePatient, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: identifier field round-trips', () => {
    fc.assert(
      fc.property(
        fieldArb(
          'identifier',
          Schema.Array(IdentifierAndReference.IdentifierSchema).pipe(
            AnnotateArrayWithArbitrary({ maxLength: 2 })
          )
        ),
        (override) => roundTrip({ ...samplePatient, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: generalPractitioner field round-trips', () => {
    fc.assert(
      fc.property(
        fieldArb(
          'generalPractitioner',
          Schema.Array(IdentifierAndReference.ReferenceSchema).pipe(
            AnnotateArrayWithArbitrary({ maxLength: 2 })
          )
        ),
        (override) => roundTrip({ ...samplePatient, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: photo field round-trips', () => {
    fc.assert(
      fc.property(
        fieldArb(
          'photo',
          Schema.Array(Attachment.Schema).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 }))
        ),
        (override) => roundTrip({ ...samplePatient, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: link field round-trips', () => {
    fc.assert(
      fc.property(
        fieldArb(
          'link',
          Schema.Array(PatientLink.Schema).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 }))
        ),
        (override) => roundTrip({ ...samplePatient, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: communication field round-trips', () => {
    fc.assert(
      fc.property(
        fieldArb(
          'communication',
          Schema.Array(PatientCommunication.Schema).pipe(
            AnnotateArrayWithArbitrary({ maxLength: 2 })
          )
        ),
        (override) => roundTrip({ ...samplePatient, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: contact field round-trips', () => {
    fc.assert(
      fc.property(
        fieldArb(
          'contact',
          Schema.Array(PatientContact.Schema).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 }))
        ),
        (override) => roundTrip({ ...samplePatient, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: managingOrganization field round-trips', () => {
    fc.assert(
      fc.property(
        fieldArb('managingOrganization', Schema.NullOr(IdentifierAndReference.ReferenceSchema)),
        (override) => roundTrip({ ...samplePatient, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: maritalStatus field round-trips', () => {
    fc.assert(
      fc.property(fieldArb('maritalStatus', Schema.NullOr(CodeableConcept.Schema)), (override) =>
        roundTrip({ ...samplePatient, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: shell primitives round-trip', () => {
    const shellArb = Arbitrary.make(
      Schema.Struct({
        active: Schema.NullOr(Schema.Boolean),
        birthDate: Schema.NullOr(TimelessDateFromString),
        deceasedBoolean: Schema.NullOr(Schema.Boolean),
        deceasedDateTime: Schema.NullOr(Schema.DateTimeUtc),
        gender: Schema.NullOr(AdministrativeGender),
        multipleBirthBoolean: Schema.NullOr(Schema.Boolean),
        multipleBirthInteger: Schema.NullOr(Schema.Int),
        language: Schema.NullOr(Code),
        implicitRules: Schema.NullOr(Schema.URL),
        meta: Schema.NullOr(Meta.Schema),
      })
    )
    fc.assert(
      fc.property(shellArb, (override) => roundTrip({ ...samplePatient, ...override })),
      {
        numRuns: numRunsFor({ base: 100 }),
      }
    )
  })
})
