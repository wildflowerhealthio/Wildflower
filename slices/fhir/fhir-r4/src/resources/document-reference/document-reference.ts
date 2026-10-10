import { Schema } from 'effect'

import { OrNullAsOptional, StructNoContext, mutableEncoded } from 'kitchen-sink/schema'

import type * as FhirR4 from 'fhir/r4.d.ts'

import * as DomainResource from '../../data-types/base/domain-resource.ts'
import * as CodeableConcept from '../../data-types/complex/codeable-concept.ts'
import * as IdentifierAndReference from '../../data-types/complex/identifier-and-reference.ts'
import * as DocumentReferenceContent from './document-reference-content.ts'
import * as DocumentReferenceContext from './document-reference-context.ts'
import * as DocumentReferenceRelatesTo from './document-reference-relates-to.ts'

const documentReferenceJsonSchema = {
  type: 'object',
  title: 'DocumentReference',
  description:
    'A reference to a document of any kind for any purpose. Provides metadata about the document so that the document can be discovered and managed.',
  required: ['resourceType', 'status', 'content'],
  properties: {
    resourceType: { type: 'string', enum: ['DocumentReference'] },
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
    masterIdentifier: {
      type: 'object',
      description: 'Master Version Specific Identifier.',
    },
    identifier: {
      type: 'array',
      items: { type: 'object' },
      description: 'Other identifiers for the document.',
    },
    status: {
      type: 'string',
      enum: ['current', 'superseded', 'entered-in-error'],
      description: 'The status of this document reference.',
    },
    docStatus: {
      type: 'string',
      enum: ['preliminary', 'final', 'amended', 'entered-in-error'],
      description: 'The status of the underlying document.',
    },
    type: {
      type: 'object',
      description: 'Kind of document (LOINC if possible).',
    },
    category: {
      type: 'array',
      items: { type: 'object' },
      description: 'Categorization of document.',
    },
    subject: {
      type: 'object',
      description: 'Who/what is the subject of the document.',
    },
    date: {
      type: 'string',
      format: 'date-time',
      description: 'When this document reference was created.',
    },
    author: {
      type: 'array',
      items: { type: 'object' },
      description: 'Who and/or what authored the document.',
    },
    authenticator: {
      type: 'object',
      description: 'Who/what authenticated the document.',
    },
    custodian: {
      type: 'object',
      description: 'Organization which maintains the document.',
    },
    relatesTo: {
      type: 'array',
      items: { type: 'object' },
      description: 'Relationships to other documents.',
    },
    description: {
      type: 'string',
      description: 'Human-readable description.',
    },
    securityLabel: {
      type: 'array',
      items: { type: 'object' },
      description: 'Document security-tags.',
    },
    content: {
      type: 'array',
      items: { type: 'object' },
      description: 'Document referenced.',
    },
    context: {
      type: 'object',
      description: 'Clinical context of document.',
    },
  },
} as const

/**
 * FHIR R4 value set for `DocumentReference.status`: current | superseded |
 * entered-in-error. Marked a modifier element by the spec and required (1..1).
 */
const StatusSchema = Schema.Literal('current', 'superseded', 'entered-in-error')

/**
 * FHIR R4 value set for `DocumentReference.docStatus`: preliminary | final |
 * amended | entered-in-error.
 */
const DocStatusSchema = Schema.Literal('preliminary', 'final', 'amended', 'entered-in-error')

const referenceArray = Schema.optionalWith(
  mutableEncoded(Schema.Array(Schema.suspend(() => IdentifierAndReference.ReferenceSchema))),
  { default: (): readonly (typeof IdentifierAndReference.ReferenceSchema.Type)[] => [] }
)

const codeableConceptArray = Schema.optionalWith(
  mutableEncoded(Schema.Array(Schema.suspend(() => CodeableConcept.Schema))),
  { default: (): readonly (typeof CodeableConcept.Schema.Type)[] => [] }
)

const DocumentReferenceStruct = Schema.extend(
  Schema.Struct({ resourceType: Schema.Literal('DocumentReference') }),
  mutableEncoded(
    StructNoContext({
      ...DomainResource.fields,
      masterIdentifier: OrNullAsOptional(
        Schema.suspend(() => IdentifierAndReference.IdentifierSchema)
      ),
      identifier: Schema.optionalWith(
        mutableEncoded(Schema.Array(Schema.suspend(() => IdentifierAndReference.IdentifierSchema))),
        {
          default: (): readonly (typeof IdentifierAndReference.IdentifierSchema.Type)[] => [],
        }
      ),
      status: StatusSchema,
      docStatus: OrNullAsOptional(DocStatusSchema),
      type: OrNullAsOptional(Schema.suspend(() => CodeableConcept.Schema)),
      category: codeableConceptArray,
      subject: OrNullAsOptional(Schema.suspend(() => IdentifierAndReference.ReferenceSchema)),
      date: OrNullAsOptional(Schema.DateTimeUtc),
      author: referenceArray,
      authenticator: OrNullAsOptional(Schema.suspend(() => IdentifierAndReference.ReferenceSchema)),
      custodian: OrNullAsOptional(Schema.suspend(() => IdentifierAndReference.ReferenceSchema)),
      relatesTo: Schema.optionalWith(
        mutableEncoded(Schema.Array(DocumentReferenceRelatesTo.Schema)),
        { default: (): readonly (typeof DocumentReferenceRelatesTo.Schema.Type)[] => [] }
      ),
      description: OrNullAsOptional(Schema.String),
      securityLabel: codeableConceptArray,
      // Required 1..* per spec — no default; a caller must supply at least one
      // content entry. Modeled as a plain (non-optional) array so its presence
      // is required on both the decoded and wire sides.
      content: mutableEncoded(Schema.Array(DocumentReferenceContent.Schema)),
      context: OrNullAsOptional(DocumentReferenceContext.Schema),
    })
  )
).annotations({ jsonSchema: documentReferenceJsonSchema })

const DocumentReferenceSchema: Schema.Schema<
  typeof DocumentReferenceStruct.Type,
  FhirR4.DocumentReference,
  never
> = DocumentReferenceStruct

/** A decoded `DocumentReference` — the type {@link DocumentReferenceSchema} produces. */
type Type = typeof DocumentReferenceSchema.Type

export { DocumentReferenceSchema as Schema, StatusSchema, DocStatusSchema }
export type { Type }
