import { Schema } from 'effect'

import {
  OrNullAsOptional,
  StructNoContext,
  TimelessDateFromString,
  mutableEncoded,
} from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import {
  Address,
  AdministrativeGender,
  Attachment,
  CodeableConcept,
  ContactPoint,
  DomainResource,
  HumanName,
  IdentifierAndReference,
} from '../../data-types/index.ts'
import * as PractitionerQualification from './practitioner-qualification.ts'

const practitionerJsonSchema = {
  type: 'object',
  title: 'Practitioner',
  description: 'A person who is directly or indirectly involved in the provisioning of healthcare.',
  required: ['resourceType'],
  properties: {
    resourceType: { type: 'string', enum: ['Practitioner'] },
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
    identifier: {
      type: 'array',
      items: { type: 'object' },
      description: 'An identifier that applies to this person in this role.',
    },
    active: {
      type: 'boolean',
      description: "Whether this practitioner's record is in active use.",
    },
    name: {
      type: 'array',
      items: { type: 'object' },
      description: 'The name(s) associated with the practitioner.',
    },
    telecom: {
      type: 'array',
      items: { type: 'object' },
      description:
        'A contact detail for the practitioner, e.g. a telephone number or an email address.',
    },
    address: {
      type: 'array',
      items: { type: 'object' },
      description:
        'Address(es) of the practitioner that are not role specific (typically home address).',
    },
    gender: {
      type: 'string',
      enum: ['male', 'female', 'other', 'unknown'],
      description:
        'Administrative Gender — the gender that the person is considered to have for administration and record keeping purposes.',
    },
    birthDate: {
      type: 'string',
      format: 'date',
      description: 'The date of birth for the practitioner.',
    },
    photo: {
      type: 'array',
      items: { type: 'object' },
      description: 'Image of the person.',
    },
    qualification: {
      type: 'array',
      items: { type: 'object' },
      description:
        'The official certifications, training, and licenses that authorize or otherwise pertain to the provision of care by the practitioner.',
    },
    communication: {
      type: 'array',
      items: { type: 'object' },
      description: 'A language the practitioner can use in patient communication.',
    },
  },
} as const

const PractitionerStruct = Schema.extend(
  Schema.Struct({ resourceType: Schema.Literal('Practitioner') }),
  mutableEncoded(
    StructNoContext({
      ...DomainResource.fields,
      identifier: Schema.optionalWith(
        mutableEncoded(Schema.Array(Schema.suspend(() => IdentifierAndReference.IdentifierSchema))),
        {
          default: (): readonly (typeof IdentifierAndReference.IdentifierSchema.Type)[] => [],
        }
      ),
      active: OrNullAsOptional(Schema.Boolean),
      name: Schema.optionalWith(
        mutableEncoded(Schema.Array(Schema.suspend(() => HumanName.Schema))),
        { default: (): readonly (typeof HumanName.Schema.Type)[] => [] }
      ),
      telecom: Schema.optionalWith(
        mutableEncoded(Schema.Array(Schema.suspend(() => ContactPoint.Schema))),
        { default: (): readonly (typeof ContactPoint.Schema.Type)[] => [] }
      ),
      address: Schema.optionalWith(
        mutableEncoded(Schema.Array(Schema.suspend(() => Address.Schema))),
        { default: (): readonly (typeof Address.Schema.Type)[] => [] }
      ),
      gender: OrNullAsOptional(AdministrativeGender),
      birthDate: OrNullAsOptional(TimelessDateFromString),
      photo: Schema.optionalWith(
        mutableEncoded(Schema.Array(Schema.suspend(() => Attachment.Schema))),
        { default: (): readonly (typeof Attachment.Schema.Type)[] => [] }
      ),
      qualification: Schema.optionalWith(
        mutableEncoded(Schema.Array(PractitionerQualification.Schema)),
        { default: (): readonly (typeof PractitionerQualification.Schema.Type)[] => [] }
      ),
      communication: Schema.optionalWith(
        mutableEncoded(Schema.Array(Schema.suspend(() => CodeableConcept.Schema))),
        { default: (): readonly (typeof CodeableConcept.Schema.Type)[] => [] }
      ),
    })
  )
).annotations({ jsonSchema: practitionerJsonSchema })

const PractitionerSchema: Schema.Schema<
  typeof PractitionerStruct.Type,
  FhirR4.Practitioner,
  never
> = PractitionerStruct

export { PractitionerSchema as Schema }
