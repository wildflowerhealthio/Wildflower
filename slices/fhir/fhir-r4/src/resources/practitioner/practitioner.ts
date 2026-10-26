import { Option, Schema, String as Str } from 'effect'

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
import { localResourceId } from '../../identity/local-resource-id.ts'
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
 * space, under {@link NAME_IDENTIFIER_SYSTEM}; `None` for a blank name, which
 * identifies nobody.
 *
 * @remarks
 * A source with no id for a provider, only a name on a label or a report,
 * names them by that name, so a reference to them carries an identity
 * (`system` and `value`) and not just a `display`. The system is shared
 * rather than per source, so the same name from two sources is one identity
 * for the importer's identity map.
 */
const nameIdentifier = (name: string): Option.Option<IdentifierAndReference.IdentifierType> => {
  const value = name.trim().replaceAll(/\s+/g, ' ')
  return value.length === 0
    ? Option.none()
    : Option.some({
        id: null,
        extension: [],
        assigner: null,
        period: null,
        system: new URL(NAME_IDENTIFIER_SYSTEM),
        type: null,
        use: null,
        value,
      })
}

/** A `Practitioner` on, or bound for, the device: one with an `id`. */
type WithId = Type & { readonly id: string }

const decodePractitioner = Schema.decodeSync(PractitionerSchema)

const NAME_IDENTIFIER_SYSTEM_HREF = new URL(NAME_IDENTIFIER_SYSTEM).href

/**
 * The provisional `Practitioner` a name identifier stands for, until a fuller
 * record of that provider arrives: the identifier, and the name as its one
 * `name[0].text`, under the id `localResourceId(system, 'Practitioner', name)`.
 *
 * @returns `None` for an identifier under any system but
 *   {@link NAME_IDENTIFIER_SYSTEM}, or one with no value or an empty one
 *
 * @remarks
 * A source that knows a provider only by name gives the importer nothing to
 * write but the name, so the record is provisional: the least that lets a
 * prescription point at its prescriber. The id is derived from the name, so
 * the same name from two sources is one record, and every later import that
 * names it adds to it rather than beside it.
 */
const fromNameIdentifier = (
  identifier: IdentifierAndReference.IdentifierType
): Option.Option<WithId> => {
  if (identifier.system?.href !== NAME_IDENTIFIER_SYSTEM_HREF) return Option.none()
  const printedName = Option.fromNullable(identifier.value).pipe(Option.filter(Str.isNonEmpty))
  return Option.map(printedName, (name) => {
    const id = localResourceId(NAME_IDENTIFIER_SYSTEM, 'Practitioner', name)
    return {
      ...decodePractitioner({
        resourceType: 'Practitioner',
        id,
        identifier: [{ system: NAME_IDENTIFIER_SYSTEM, value: name }],
        name: [{ text: name }],
      }),
      id,
    }
  })
}

export { fromNameIdentifier, NAME_IDENTIFIER_SYSTEM, nameIdentifier, PractitionerSchema as Schema }
export type { Type, WithId }
