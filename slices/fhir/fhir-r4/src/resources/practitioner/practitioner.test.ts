import {
  AnnotateArrayWithArbitrary,
  TimelessDateFromString,
} from '@wildflowerhealthio/kitchen-sink/schema'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Arbitrary, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { Code } from '../../data-types/base/code.ts'
import {
  Address,
  AdministrativeGender,
  Attachment,
  CodeableConcept,
  ContactPoint,
  HumanName,
  IdentifierAndReference,
  Meta,
} from '../../data-types/index.ts'
import * as PractitionerQualification from './practitioner-qualification.ts'
import * as Practitioner from './practitioner.ts'

// ---------------------------------------------------------------------------
// Decomposed wire-format proof (see observation.test.ts for the rationale):
// one property per field over a fixed shell, each encoding/decoding the WHOLE
// Practitioner through `Practitioner.Schema`.
// ---------------------------------------------------------------------------

const samplePractitioner: typeof Practitioner.Schema.Type = {
  resourceType: 'Practitioner',
  id: 'practitioner-id',
  implicitRules: null,
  language: null,
  meta: null,
  contained: [],
  extension: [],
  modifierExtension: [],
  text: null,
  identifier: [],
  active: null,
  name: [],
  telecom: [],
  address: [],
  gender: null,
  birthDate: null,
  photo: [],
  qualification: [],
  communication: [],
}

const roundTrip = (practitioner: typeof Practitioner.Schema.Type): void => {
  const fhir = Schema.encodeSync(Practitioner.Schema)(practitioner)
  const decoded = Schema.decodeSync(Practitioner.Schema)(fhir)
  expect(decoded).toSchemaEqual(Practitioner.Schema, practitioner)
}

const overrideArb = <Fields extends Schema.Struct.Fields>(
  fields: Fields
): fc.Arbitrary<Schema.Schema.Type<Schema.Struct<Fields>>> => Arbitrary.make(Schema.Struct(fields))

describe('FhirR4Practitioner', () => {
  test('encode-decode round-trip with shell practitioner', () => {
    roundTrip(samplePractitioner)
  })

  test('decodes the minimal wire form — only resourceType is required', () => {
    expect(
      Schema.decodeUnknownSync(Practitioner.Schema)({ resourceType: 'Practitioner' })
    ).toSchemaEqual(Practitioner.Schema, { ...samplePractitioner, id: null })
  })

  test('property: identifier[] round-trips', () => {
    fc.assert(
      fc.property(
        overrideArb({
          identifier: Schema.Array(IdentifierAndReference.IdentifierSchema).pipe(
            AnnotateArrayWithArbitrary({ maxLength: 2 })
          ),
        }),
        (override) => roundTrip({ ...samplePractitioner, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: demographic fields round-trip (name[] / telecom[] / address[] / photo[])', () => {
    fc.assert(
      fc.property(
        overrideArb({
          name: Schema.Array(HumanName.Schema).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 })),
          telecom: Schema.Array(ContactPoint.Schema).pipe(
            AnnotateArrayWithArbitrary({ maxLength: 2 })
          ),
          address: Schema.Array(Address.Schema).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 })),
          photo: Schema.Array(Attachment.Schema).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 })),
        }),
        (override) => roundTrip({ ...samplePractitioner, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: qualification backbone array round-trips', () => {
    fc.assert(
      fc.property(
        overrideArb({
          qualification: Schema.Array(PractitionerQualification.Schema).pipe(
            AnnotateArrayWithArbitrary({ maxLength: 2 })
          ),
        }),
        (override) => roundTrip({ ...samplePractitioner, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: communication[] round-trips', () => {
    fc.assert(
      fc.property(
        overrideArb({
          communication: Schema.Array(CodeableConcept.Schema).pipe(
            AnnotateArrayWithArbitrary({ maxLength: 2 })
          ),
        }),
        (override) => roundTrip({ ...samplePractitioner, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: shell primitives round-trip', () => {
    fc.assert(
      fc.property(
        overrideArb({
          active: Schema.NullOr(Schema.Boolean),
          gender: Schema.NullOr(AdministrativeGender),
          birthDate: Schema.NullOr(TimelessDateFromString),
          language: Schema.NullOr(Code),
          implicitRules: Schema.NullOr(Schema.URL),
          meta: Schema.NullOr(Meta.Schema),
        }),
        (override) => roundTrip({ ...samplePractitioner, ...override })
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('Practitioner.nameIdentifier', () => {
  const decodeIdentifier = Schema.decodeUnknownSync(IdentifierAndReference.IdentifierSchema)

  test('names a provider by their printed name under the practitioner-name system', () => {
    expect(Practitioner.nameIdentifier('Dr. A Prescriber')).toSchemaEqual(
      IdentifierAndReference.IdentifierSchema,
      decodeIdentifier({
        system: 'https://wildflowerhealth.io/fhir/identifier/practitioner-name',
        value: 'Dr. A Prescriber',
      })
    )
  })

  test('trims the name and collapses each run of whitespace inside it to one space', () => {
    expect(Practitioner.nameIdentifier(' \tDr.  A\n Prescriber  ').value).toBe('Dr. A Prescriber')
  })

  test('gives a blank name no value, as FHIR decodes a blank string', () => {
    expect(Practitioner.nameIdentifier(' \t ').value).toBeNull()
  })

  const whitespaceArbitrary = fc.constantFrom(' ', '  ', '\t', '\n ')

  test('property: one name spelled with different spacing is one identifier', () => {
    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^\S+$/), { minLength: 1, maxLength: 4 }),
        fc.tuple(whitespaceArbitrary, whitespaceArbitrary, whitespaceArbitrary),
        (words, [before, between, after]) => {
          const spaced = `${before}${words.join(between)}${after}`
          expect(Practitioner.nameIdentifier(spaced)).toSchemaEqual(
            IdentifierAndReference.IdentifierSchema,
            Practitioner.nameIdentifier(words.join(' '))
          )
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
