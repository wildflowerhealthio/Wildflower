import { Schema } from 'effect'

import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import {
  CodeableConcept,
  DomainResource,
  IdentifierAndReference,
  Ratio,
} from '../../data-types/index.ts'
import * as Batch from './medication-batch.ts'
import * as Ingredient from './medication-ingredient.ts'

const medicationJsonSchema = {
  type: 'object',
  title: 'Medication',
  description:
    'This resource is primarily used for the identification and definition of a medication for the purposes of prescribing, dispensing, and administering a medication as well as for making statements about medication use.',
  required: ['resourceType'],
  properties: {
    resourceType: { type: 'string', enum: ['Medication'] },
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
      description: 'Business identifier for this medication.',
    },
    code: {
      type: 'object',
      description: 'Codes that identify this medication.',
    },
    status: {
      type: 'string',
      enum: ['active', 'inactive', 'entered-in-error'],
      description: 'A code to indicate if the medication is in active use.',
    },
    manufacturer: {
      type: 'object',
      description: 'Manufacturer of the item.',
    },
    form: {
      type: 'object',
      description: 'Describes the form of the item (powder, tablets, capsule, etc.).',
    },
    amount: {
      type: 'object',
      description: 'Specific amount of the drug in the packaged product.',
    },
    ingredient: {
      type: 'array',
      items: { type: 'object' },
      description: 'Active or inactive ingredient.',
    },
    batch: {
      type: 'object',
      description: 'Details about packaged medications.',
    },
  },
} as const

/** FHIR R4 value set for `Medication.status`: active | inactive | entered-in-error. */
const StatusSchema = Schema.Literal('active', 'inactive', 'entered-in-error')

const MedicationStruct = Schema.extend(
  Schema.Struct({ resourceType: Schema.Literal('Medication') }),
  mutableEncoded(
    StructNoContext({
      ...DomainResource.fields,
      identifier: Schema.optionalWith(
        mutableEncoded(Schema.Array(Schema.suspend(() => IdentifierAndReference.IdentifierSchema))),
        {
          default: (): readonly (typeof IdentifierAndReference.IdentifierSchema.Type)[] => [],
        }
      ),
      code: OrNullAsOptional(Schema.suspend(() => CodeableConcept.Schema)),
      status: OrNullAsOptional(StatusSchema),
      manufacturer: OrNullAsOptional(Schema.suspend(() => IdentifierAndReference.ReferenceSchema)),
      form: OrNullAsOptional(Schema.suspend(() => CodeableConcept.Schema)),
      amount: OrNullAsOptional(Schema.suspend(() => Ratio.Schema)),
      ingredient: Schema.optionalWith(mutableEncoded(Schema.Array(Ingredient.Schema)), {
        default: (): readonly (typeof Ingredient.Schema.Type)[] => [],
      }),
      batch: OrNullAsOptional(Batch.Schema),
    })
  )
).annotations({ jsonSchema: medicationJsonSchema })

/**
 * All-empty R4 `Medication`: every field carries its "absent" value. Spread it
 * to build a Medication that overwrites only the slots a source populates (see
 * the STU3→R4 transforms in `fhir-stu3-as-r4`).
 */
const empty: typeof MedicationStruct.Type = {
  resourceType: 'Medication',
  id: null,
  implicitRules: null,
  language: null,
  meta: null,
  contained: [],
  extension: [],
  modifierExtension: [],
  text: null,
  identifier: [],
  code: null,
  status: null,
  manufacturer: null,
  form: null,
  amount: null,
  ingredient: [],
  batch: null,
}

const MedicationSchema: Schema.Schema<typeof MedicationStruct.Type, FhirR4.Medication, never> =
  MedicationStruct

export { MedicationSchema as Schema, StatusSchema, empty }
