import { Schema } from 'effect'

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
  CodeableConcept,
  ContactPoint,
  DomainResource,
  HumanName,
  IdentifierAndReference,
  WILDFLOWER_CANONICAL_BASE,
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

/** A decoded `Practitioner` — the type {@link PractitionerSchema} produces. */
type Type = typeof PractitionerSchema.Type

/**
 * The Wildflower-minted identifier system for a provider known only by the
 * name a source prints, the name as the value: see {@link nameIdentifier}.
 */
const NAME_IDENTIFIER_SYSTEM = `${WILDFLOWER_CANONICAL_BASE}/identifier/practitioner-name`

/**
 * The identifier for a provider a source knows only by its printed `name`:
 * the name, trimmed and with each run of whitespace inside it collapsed to one
 * space, under {@link NAME_IDENTIFIER_SYSTEM}.
 *
 * @remarks
 * A source with no id for a provider, only a name on a label or a report,
 * names them by that name, so a reference to them carries an identity
 * (`system` and `value`) and not just a `display`. The system is shared
 * rather than per source, so the same name from two sources is one identity
 * for the importer's identity map. A blank `name` has no value, as FHIR
 * decodes a blank string.
 */
const nameIdentifier = (name: string): IdentifierAndReference.IdentifierType => {
  const value = name.trim().replaceAll(/\s+/g, ' ')
  return {
    id: null,
    extension: [],
    assigner: null,
    period: null,
    system: new URL(NAME_IDENTIFIER_SYSTEM),
    type: null,
    use: null,
    value: value.length > 0 ? value : null,
  }
}

export { NAME_IDENTIFIER_SYSTEM, nameIdentifier, PractitionerSchema as Schema }
export type { Type }
