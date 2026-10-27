import { DateTime, Effect, Option, Schema } from 'effect'

import {
  OrNullAsOptional,
  StructNoContext,
  TimelessDateFromString,
  mutableEncoded,
} from '@wildflowerhealthio/kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import {
  Address,
  AdministrativeGender,
  Attachment,
  ChoiceElementSet,
  CodeableConcept,
  filterForExclusiveChoiceElementSet,
  choiceElementSetPassthroughFields,
  ContactPoint,
  DomainResource,
  HumanName,
  IdentifierAndReference,
  WILDFLOWER_CANONICAL_BASE,
} from '../../data-types/index.ts'
import * as PatientCommunication from './patient-communication.ts'
import * as PatientContact from './patient-contact.ts'
import * as PatientLink from './patient-link.ts'

const patientJsonSchema = {
  type: 'object',
  title: 'Patient',
  description:
    'Demographics and other administrative information about an individual or animal receiving care or other health-related services.',
  required: ['resourceType'],
  properties: {
    resourceType: { type: 'string', enum: ['Patient'] },
    id: { type: 'string', description: 'Logical id of this artifact.' },
    meta: { type: 'object', description: 'Metadata about the resource.' },
    implicitRules: {
      type: 'string',
      format: 'uri',
      description: 'A set of rules under which this content was created.',
    },
    language: { type: 'string', description: 'Language of the resource content.' },
    text: { type: 'object', description: 'Human-readable summary of the resource.' },
    contained: { type: 'array', items: { type: 'object' } },
    extension: { type: 'array', items: { type: 'object' } },
    modifierExtension: { type: 'array', items: { type: 'object' } },
    active: {
      type: 'boolean',
      description: 'Whether this patient record is in active use.',
    },
    address: {
      type: 'array',
      items: { type: 'object' },
      description:
        'An address for the individual. Patient may have multiple addresses with different uses or applicable periods.',
    },
    birthDate: {
      type: 'string',
      format: 'date',
      description: 'The date of birth for the individual.',
    },
    communication: {
      type: 'array',
      items: { type: 'object' },
      description:
        'A language which may be used to communicate with the patient about his or her health.',
    },
    contact: {
      type: 'array',
      items: { type: 'object' },
      description: 'A contact party (e.g. guardian, partner, friend) for the patient.',
    },
    deceasedBoolean: {
      type: 'boolean',
      description: 'Indicates if the individual is deceased or not.',
    },
    deceasedDateTime: {
      type: 'string',
      format: 'date-time',
      description: 'Indicates if the individual is deceased or not.',
    },
    gender: {
      type: 'string',
      enum: ['male', 'female', 'other', 'unknown'],
      description: 'Administrative gender - the gender that the patient is considered to have.',
    },
    generalPractitioner: {
      type: 'array',
      items: { type: 'object' },
      description:
        "Patient's nominated care provider. May be a primary care provider, a patient nominated care manager, or organization.",
    },
    identifier: {
      type: 'array',
      items: { type: 'object' },
      description: 'An identifier for this patient.',
    },
    link: {
      type: 'array',
      items: { type: 'object' },
      description: 'Link to another patient resource that concerns the same actual patient.',
    },
    managingOrganization: {
      type: 'object',
      description:
        'Organization that is the custodian of the patient record. There is only one managing organization for a specific patient record.',
    },
    maritalStatus: {
      type: 'object',
      description: "This field contains a patient's most recent marital (civil) status.",
    },
    multipleBirthBoolean: {
      type: 'boolean',
      description: 'Indicates whether the patient is part of a multiple (boolean) birth.',
    },
    multipleBirthInteger: {
      type: 'integer',
      description: 'Indicates the actual birth order when the patient is part of a multiple birth.',
    },
    name: {
      type: 'array',
      items: { type: 'object' },
      description:
        'A name associated with the individual. A patient may have multiple names with different uses or applicable periods.',
    },
    photo: {
      type: 'array',
      items: { type: 'object' },
      description: 'Image of the patient.',
    },
    telecom: {
      type: 'array',
      items: { type: 'object' },
      description:
        'A contact detail (e.g. a telephone number or an email address) by which the individual may be contacted.',
    },
  },
} as const

const PatientStruct = Schema.extend(
  Schema.Struct({ resourceType: Schema.Literal('Patient') }),
  mutableEncoded(
    StructNoContext({
      ...DomainResource.fields,
      active: OrNullAsOptional(Schema.Boolean),
      address: Schema.optionalWith(
        mutableEncoded(Schema.Array(Schema.suspend(() => Address.Schema))),
        { default: (): readonly (typeof Address.Schema.Type)[] => [] }
      ),
      birthDate: OrNullAsOptional(TimelessDateFromString),
      communication: Schema.optionalWith(
        mutableEncoded(Schema.Array(PatientCommunication.Schema)),
        { default: (): readonly (typeof PatientCommunication.Schema.Type)[] => [] }
      ),
      contact: Schema.optionalWith(mutableEncoded(Schema.Array(PatientContact.Schema)), {
        default: (): readonly (typeof PatientContact.Schema.Type)[] => [],
      }),
      ...choiceElementSetPassthroughFields(
        'deceased',
        ChoiceElementSet.FhirR4SetChoices['Patient.deceased[x]']
      ),
      gender: OrNullAsOptional(AdministrativeGender),
      generalPractitioner: Schema.optionalWith(
        mutableEncoded(Schema.Array(Schema.suspend(() => IdentifierAndReference.ReferenceSchema))),
        {
          default: (): readonly (typeof IdentifierAndReference.ReferenceSchema.Type)[] => [],
        }
      ),
      identifier: Schema.optionalWith(
        mutableEncoded(Schema.Array(Schema.suspend(() => IdentifierAndReference.IdentifierSchema))),
        {
          default: (): readonly (typeof IdentifierAndReference.IdentifierSchema.Type)[] => [],
        }
      ),
      link: Schema.optionalWith(mutableEncoded(Schema.Array(PatientLink.Schema)), {
        default: (): readonly (typeof PatientLink.Schema.Type)[] => [],
      }),
      managingOrganization: OrNullAsOptional(
        Schema.suspend(() => IdentifierAndReference.ReferenceSchema)
      ),
      maritalStatus: OrNullAsOptional(Schema.suspend(() => CodeableConcept.Schema)),
      ...choiceElementSetPassthroughFields(
        'multipleBirth',
        ChoiceElementSet.FhirR4SetChoices['Patient.multipleBirth[x]']
      ),
      name: Schema.optionalWith(
        mutableEncoded(Schema.Array(Schema.suspend(() => HumanName.Schema))),
        { default: (): readonly (typeof HumanName.Schema.Type)[] => [] }
      ),
      photo: Schema.optionalWith(
        mutableEncoded(Schema.Array(Schema.suspend(() => Attachment.Schema))),
        { default: (): readonly (typeof Attachment.Schema.Type)[] => [] }
      ),
      telecom: Schema.optionalWith(
        mutableEncoded(Schema.Array(Schema.suspend(() => ContactPoint.Schema))),
        { default: (): readonly (typeof ContactPoint.Schema.Type)[] => [] }
      ),
    })
  )
)
  .pipe(
    filterForExclusiveChoiceElementSet(
      'deceased',
      ChoiceElementSet.FhirR4SetChoices['Patient.deceased[x]']
    ),
    filterForExclusiveChoiceElementSet(
      'multipleBirth',
      ChoiceElementSet.FhirR4SetChoices['Patient.multipleBirth[x]']
    )
  )
  .annotations({ jsonSchema: patientJsonSchema })

const PatientSchema: Schema.Schema<typeof PatientStruct.Type, FhirR4.Patient, never> = PatientStruct

/** A decoded `Patient` — the type {@link PatientSchema} produces. */
type Type = typeof PatientSchema.Type

/**
 * The Wildflower identifier system for a person's name and birth date, under
 * which {@link nameBirthDateIdentifier} mints its identifier.
 */
const NAME_BIRTH_DATE_IDENTIFIER_SYSTEM = `${WILDFLOWER_CANONICAL_BASE}/identifier/patient-name-birth-date`

/**
 * A name part in Unicode NFC, lower-cased, trimmed, and with every run of
 * whitespace collapsed to one space, so an accented letter spelled as one code
 * point or as a letter plus a combining mark mints the same identifier.
 */
const normalizeNamePart = (namePart: string): string =>
  namePart.normalize('NFC').trim().replaceAll(/\s+/g, ' ').toLowerCase()

/**
 * A patient's demographics as one person is told from another: the family
 * and given names of the name they go by (`HumanName.currentName`, among the
 * names that state a family or a given name: a `text`-only name shows but
 * tells no one apart), each normalised as {@link normalizeNamePart} does, and
 * the birth date; each `None` when the patient does not state it.
 */
interface Demographics {
  readonly family: Option.Option<string>
  /** The given names joined by a space. */
  readonly given: Option.Option<string>
  readonly birthDate: Option.Option<typeof TimelessDateFromString.Type>
}

/**
 * The {@link Demographics} of `patient`: what {@link nameBirthDateIdentifier}
 * is minted from, and what a review compares two records of one person by,
 * so both read the same normalised parts. Which name is current is judged at
 * the clock's now, so an Effect.
 */
/** Whether `name` states a family or a given name, the parts demographics are read from. */
const hasNameParts = (name: typeof HumanName.Schema.Type): boolean =>
  name.family !== null || name.given.length > 0

const demographics = (patient: Type): Effect.Effect<Demographics> =>
  Effect.map(DateTime.now, (now) => {
    const currentName = HumanName.currentName(patient.name.filter(hasNameParts), now)
    return {
      family: currentName.pipe(
        Option.flatMapNullable((name) => name.family),
        Option.map(normalizeNamePart),
        Option.filter((namePart) => namePart.length > 0)
      ),
      given: currentName.pipe(
        Option.map((name) => normalizeNamePart(name.given.join(' '))),
        Option.filter((namePart) => namePart.length > 0)
      ),
      birthDate: Option.fromNullable(patient.birthDate),
    }
  })

/**
 * The identifier a patient's current name and birth date mint under
 * {@link NAME_BIRTH_DATE_IDENTIFIER_SYSTEM}: `family;given…;YYYY-MM-DD`, the
 * given names joined by a space, in NFC, lower-cased with whitespace collapsed;
 * an Effect, since which name is current is judged at the clock's now.
 *
 * @remarks
 * A person is identified by name and birth date so the same person from two
 * sources is one identity for the importer's identity map. A name change
 * mints a different identifier, and the person keeps both. `None` unless the
 * current name's family, at least one given name, and `birthDate` are all
 * present ({@link demographics}), so a partial match never links two people.
 * The parts are joined by `;` rather than `|`, which a FHIR token search reads
 * as the system separator, so the value is searched as
 * `system|family;given;date` with nothing to escape.
 */
const nameBirthDateIdentifier = (
  patient: Type
): Effect.Effect<Option.Option<IdentifierAndReference.IdentifierType>> =>
  Effect.map(demographics(patient), ({ family, given, birthDate }) =>
    Option.all([family, given, birthDate]).pipe(
      Option.map((valueParts): IdentifierAndReference.IdentifierType => ({
        id: null,
        extension: [],
        assigner: null,
        period: null,
        system: new URL(NAME_BIRTH_DATE_IDENTIFIER_SYSTEM),
        type: null,
        use: null,
        value: valueParts.join(';'),
      }))
    )
  )

export {
  demographics,
  NAME_BIRTH_DATE_IDENTIFIER_SYSTEM,
  nameBirthDateIdentifier,
  PatientSchema as Schema,
}
export type { Demographics, Type }
