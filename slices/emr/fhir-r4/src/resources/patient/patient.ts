import { Schema } from 'effect'

import type { Patient as StorePatient } from 'emr-core/livestore'
import { AdministrativeGender, ChoiceElementSet } from 'emr-core/schemas'
import {
  OrNullAsOptional,
  StructNoContext,
  TimelessDateFromString,
  mutableEncoded,
} from 'kitchen-sink/schema'

import type FhirR4 from 'fhir/r4.d.ts'

import {
  Address,
  Attachment,
  CodeableConcept,
  choiceElementSetPassthroughFields,
  ContactPoint,
  DomainResource,
  HumanName,
  IdentifierAndReference,
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

const PatientSchema: Schema.Schema<
  typeof StorePatient.RowSchemaNullableId.Type,
  FhirR4.Patient,
  never
> = Schema.extend(
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
).annotations({ jsonSchema: patientJsonSchema })

export { PatientSchema as Schema }
