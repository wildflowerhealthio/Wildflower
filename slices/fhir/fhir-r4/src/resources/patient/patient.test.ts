import {
  AnnotateArrayWithArbitrary,
  TimelessDateFromString,
} from '@wildflowerhealthio/kitchen-sink/schema'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Arbitrary, DateTime, Effect, Option, Schema, TestClock, TestContext } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { atMostOnePopulatedSlot } from '../../data-types/base/choice-element-passthrough-fields.test-helpers.ts'
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

/** `effect` run on the test clock, which `Patient.demographics` reads to tell a current name. */
const runOnTestClock = <A>(effect: Effect.Effect<A>): A =>
  Effect.runSync(Effect.provide(effect, TestContext.TestContext))

const mintOnTestClock = (
  patient: typeof Patient.Schema.Type
): Option.Option<IdentifierAndReference.IdentifierType> =>
  runOnTestClock(Patient.nameBirthDateIdentifier(patient))

const demographicsOnTestClock = (patient: typeof Patient.Schema.Type): Patient.Demographics =>
  runOnTestClock(Patient.demographics(patient))

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
        gender: Schema.NullOr(AdministrativeGender),
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

  test('property: deceased[x] choice field round-trips', () => {
    const deceasedArb = atMostOnePopulatedSlot({
      deceasedBoolean: Schema.NullOr(Schema.Boolean),
      deceasedDateTime: Schema.NullOr(Schema.DateTimeUtc),
    })
    fc.assert(
      fc.property(deceasedArb, (override) => roundTrip({ ...samplePatient, ...override })),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: multipleBirth[x] choice field round-trips', () => {
    const multipleBirthArb = atMostOnePopulatedSlot({
      multipleBirthBoolean: Schema.NullOr(Schema.Boolean),
      multipleBirthInteger: Schema.NullOr(Schema.Int),
    })
    fc.assert(
      fc.property(multipleBirthArb, (override) => roundTrip({ ...samplePatient, ...override })),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('Patient.nameBirthDateIdentifier', () => {
  const humanName = ({
    family,
    given,
  }: {
    readonly family: string | null
    readonly given: readonly string[]
  }): typeof HumanName.Schema.Type => ({
    id: null,
    extension: [],
    family,
    given,
    period: null,
    prefix: [],
    suffix: [],
    text: null,
    use: null,
  })

  const decodeBirthDate = Schema.decodeSync(TimelessDateFromString)

  const patientNamed = ({
    names,
    birthDate,
  }: {
    readonly names: readonly (typeof HumanName.Schema.Type)[]
    readonly birthDate: string | null
  }): typeof Patient.Schema.Type => ({
    ...samplePatient,
    name: names,
    birthDate: birthDate === null ? null : decodeBirthDate(birthDate),
  })

  /** One word of a name: letters whose case round-trips, an apostrophe or a hyphen. */
  const nameWordArb = fc.stringMatching(/^[A-Za-zéÉ'-]{1,8}$/)
  /** A name part of one to three words, each separated by a single space. */
  const namePartArb = fc
    .array(nameWordArb, { minLength: 1, maxLength: 3 })
    .map((words) => words.join(' '))
  const fullNameArb = fc.record({
    family: namePartArb,
    given: fc.array(namePartArb, { minLength: 1, maxLength: 3 }),
    birthDate: Arbitrary.make(TimelessDateFromString),
  })

  const whitespaceRunArb = fc.stringMatching(/^[ \t\n]{1,3}$/)
  /** `word` with each letter in either case. */
  const recasedArb = (word: string): fc.Arbitrary<string> =>
    fc
      .tuple(...word.split('').map((letter) => fc.constantFrom(letter, letter.toUpperCase())))
      .map((letters) => letters.join(''))
  /** `namePart` re-spelled in mixed case, with runs of whitespace before, between and after its words. */
  const respelledArb = (namePart: string): fc.Arbitrary<string> =>
    fc
      .tuple(
        fc.tuple(
          ...namePart
            .split(' ')
            .map((word) =>
              fc
                .tuple(whitespaceRunArb, recasedArb(word))
                .map(([whitespaceRun, recased]) => `${whitespaceRun}${recased}`)
            )
        ),
        whitespaceRunArb
      )
      .map(([words, trailingWhitespace]) => `${words.join('')}${trailingWhitespace}`)

  test('mints family;given…;birth date under the Wildflower system, lower-cased', () => {
    // Arrange
    const patient = patientNamed({
      names: [humanName({ family: 'Smith', given: ['Tyra', 'Jane'] })],
      birthDate: '1990-04-02',
    })

    // Act
    const identifier = mintOnTestClock(patient)

    // Assert
    expect(Option.getOrNull(identifier)).toSchemaEqual(IdentifierAndReference.IdentifierSchema, {
      id: null,
      extension: [],
      assigner: null,
      period: null,
      system: new URL('https://wildflowerhealth.io/fhir/identifier/patient-name-birth-date'),
      type: null,
      use: null,
      value: 'smith;tyra jane;1990-04-02',
    })
    expect(Patient.NAME_BIRTH_DATE_IDENTIFIER_SYSTEM).toBe(
      'https://wildflowerhealth.io/fhir/identifier/patient-name-birth-date'
    )
  })

  test('mints the same identifier for a name in composed and decomposed Unicode', () => {
    // Arrange
    const patientWithFamily = (family: string): typeof Patient.Schema.Type =>
      patientNamed({
        names: [humanName({ family, given: ['Tyra'] })],
        birthDate: '1990-04-02',
      })

    // Act
    const composed = mintOnTestClock(patientWithFamily('Jos\u00e9'))
    const decomposed = mintOnTestClock(patientWithFamily('Jose\u0301'))

    // Assert
    expect(decomposed).toEqual(composed)
  })

  test.each([
    { reason: 'no name', names: [], birthDate: '1990-04-02' },
    {
      reason: 'a first name with no family',
      names: [
        humanName({ family: null, given: ['Tyra'] }),
        humanName({ family: 'Smith', given: ['Tyra'] }),
      ],
      birthDate: '1990-04-02',
    },
    {
      reason: 'a first name with a blank family',
      names: [humanName({ family: '  ', given: ['Tyra'] })],
      birthDate: '1990-04-02',
    },
    {
      reason: 'a first name with no given name',
      names: [humanName({ family: 'Smith', given: [] })],
      birthDate: '1990-04-02',
    },
    {
      reason: 'a first name whose given names are blank',
      names: [humanName({ family: 'Smith', given: [' ', '\t'] })],
      birthDate: '1990-04-02',
    },
    {
      reason: 'no birth date',
      names: [humanName({ family: 'Smith', given: ['Tyra'] })],
      birthDate: null,
    },
  ])('mints nothing for a patient with $reason', ({ names, birthDate }) => {
    expect(mintOnTestClock(patientNamed({ names, birthDate }))).toEqual(Option.none())
  })

  test('property: mints the same identifier whatever the case and whitespace of the name', () => {
    const fullNameWithRespellingArb = fullNameArb.chain((fullName) =>
      fc.record({
        fullName: fc.constant(fullName),
        respelledFamily: respelledArb(fullName.family),
        respelledGiven: fc.tuple(...fullName.given.map(respelledArb)),
      })
    )
    fc.assert(
      fc.property(fullNameWithRespellingArb, ({ fullName, respelledFamily, respelledGiven }) => {
        // Arrange
        const birthDate = Schema.encodeSync(TimelessDateFromString)(fullName.birthDate)
        const plain = patientNamed({
          names: [humanName({ family: fullName.family, given: fullName.given })],
          birthDate,
        })
        const respelled = patientNamed({
          names: [humanName({ family: respelledFamily, given: respelledGiven })],
          birthDate,
        })

        // Act / Assert
        expect(Option.map(mintOnTestClock(respelled), ({ value }) => value)).toEqual(
          Option.some(`${fullName.family};${fullName.given.join(' ')};${birthDate}`.toLowerCase())
        )
        expect(mintOnTestClock(respelled)).toEqual(mintOnTestClock(plain))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: a patient named by its own identifier mints that identifier again', () => {
    fc.assert(
      fc.property(fullNameArb, (fullName) => {
        // Arrange
        const minted = mintOnTestClock(
          patientNamed({
            names: [humanName({ family: fullName.family, given: fullName.given })],
            birthDate: Schema.encodeSync(TimelessDateFromString)(fullName.birthDate),
          })
        ).pipe(Option.getOrThrow)
        const [family = '', given = '', birthDate = ''] = (minted.value ?? '').split(';')

        // Act
        const remintedFromOwnParts = mintOnTestClock(
          patientNamed({ names: [humanName({ family, given: [given] })], birthDate })
        )

        // Assert
        expect(remintedFromOwnParts).toEqual(Option.some(minted))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('Patient.demographics', () => {
  const patientOf = (wire: object): typeof Patient.Schema.Type =>
    Schema.decodeUnknownSync(Patient.Schema)({ resourceType: 'Patient', ...wire })

  test('should read the first name’s family and given names, normalised, and the birth date', () => {
    const demographics = demographicsOnTestClock(
      patientOf({
        name: [
          { family: '  Van  Der Berg ', given: ['Tyra', 'Lynne'] },
          { family: 'Other', given: ['X'] },
        ],
        birthDate: '1990-01-02',
      })
    )

    expect(demographics).toEqual({
      family: Option.some('van der berg'),
      given: Option.some('tyra lynne'),
      birthDate: Option.some('1990-01-02'),
    })
  })

  test('should read the name the patient goes by now, not the first in record order', async () => {
    const renamed = patientOf({
      name: [
        { use: 'maiden', family: 'Banks', given: ['Tyra'] },
        { use: 'official', family: 'Doe', given: ['Tyra'] },
      ],
      birthDate: '1990-01-02',
    })
    const endedName = patientOf({
      name: [
        { family: 'Banks', given: ['Tyra'], period: { end: '2020-06-01' } },
        { family: 'Doe', given: ['Tyra'] },
      ],
      birthDate: '1990-01-02',
    })

    const textOnlyOfficial = patientOf({
      name: [
        { use: 'usual', family: 'Smith', given: ['Jo'] },
        { use: 'official', text: 'Joanna Smith' },
      ],
      birthDate: '1990-01-02',
    })

    expect(demographicsOnTestClock(renamed).family).toEqual(Option.some('doe'))
    // A text-only name shows, but the parts are read from the name that states them.
    expect(demographicsOnTestClock(textOnlyOfficial)).toEqual({
      family: Option.some('smith'),
      given: Option.some('jo'),
      birthDate: Option.some('1990-01-02'),
    })
    expect(Option.map(mintOnTestClock(renamed), ({ value }) => value)).toEqual(
      Option.some('doe;tyra;1990-01-02')
    )
    // At the test clock's start the first name's period has not ended.
    expect(demographicsOnTestClock(endedName).family).toEqual(Option.some('banks'))
    const familyAfterTheEnd = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.unsafeMake('2021-01-01')))
        return (yield* Patient.demographics(endedName)).family
      }).pipe(Effect.provide(TestContext.TestContext))
    )
    expect(familyAfterTheEnd).toEqual(Option.some('doe'))
  })

  test('should read None for each part the patient does not state', () => {
    expect(demographicsOnTestClock(patientOf({ name: [{ family: 'Banks' }] }))).toEqual({
      family: Option.some('banks'),
      given: Option.none(),
      birthDate: Option.none(),
    })
    expect(demographicsOnTestClock(patientOf({ birthDate: '1990-01-02' }))).toEqual({
      family: Option.none(),
      given: Option.none(),
      birthDate: Option.some('1990-01-02'),
    })
  })

  test('should always be what the name-and-birth-date identifier is minted from, joined by ;', () => {
    const nameWordArb = fc.stringMatching(/^[A-Za-zéÉ]{1,8}$/)
    fc.assert(
      fc.property(
        nameWordArb,
        fc.array(nameWordArb, { minLength: 1 }),
        Arbitrary.make(TimelessDateFromString),
        (family, given, birthDate) => {
          // Arrange
          const patient = patientOf({ name: [{ family, given }], birthDate })

          // Act
          const demographics = demographicsOnTestClock(patient)
          const identifier = mintOnTestClock(patient)

          // Assert
          expect(Option.map(identifier, ({ value }) => value)).toEqual(
            Option.map(
              Option.all([demographics.family, demographics.given, demographics.birthDate]),
              (parts) => parts.join(';')
            )
          )
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})
