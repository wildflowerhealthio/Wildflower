import { Arbitrary, type FastCheck, Schema } from 'effect'

import { AnnotateArrayWithArbitrary } from 'kitchen-sink/schema'

import { State } from '@livestore/livestore'
import { makeDomainResourcePersistence } from '../internal/domain-resource-persistence.ts'
import { makeRowSchemas } from '../internal/make-row-schemas.ts'
import * as ChoiceElementSet from '../schemas/choice-element-set.ts'
import * as Annotation from '../schemas/datatypes/annotation.ts'
import * as CodeableConcept from '../schemas/datatypes/codeable-concept.ts'
import * as Identifier from '../schemas/datatypes/identifier.ts'
import * as Reference from '../schemas/datatypes/reference.ts'
import * as DomainResource from './domain-resource.ts'
import * as ObservationComponent from './observation-component.ts'
import * as ObservationReferenceRange from './observation-reference-range.ts'

/**
 * FHIR R4 value set for `Observation.status`: registered | preliminary | final |
 * amended | corrected | cancelled | entered-in-error | unknown.
 */
const StatusSchema = Schema.Enums({
  amended: 'amended',
  cancelled: 'cancelled',
  corrected: 'corrected',
  'entered-in-error': 'entered-in-error',
  final: 'final',
  preliminary: 'preliminary',
  registered: 'registered',
  unknown: 'unknown',
} as const)

/** Decoded status value for an Observation. */
type Status = typeof StatusSchema.Type

const resourceType = 'Observation' as const

const columns = {
  ...DomainResource.columns,
  resourceType: State.SQLite.text({
    default: resourceType,
    schema: Schema.Literal(resourceType),
  }),
  id: State.SQLite.text({ primaryKey: true }),
  basedOn: State.SQLite.json({
    schema: Schema.Array(Reference.Schema).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 })),
  }),
  bodySite: State.SQLite.json({ nullable: true, schema: CodeableConcept.Schema }),
  category: State.SQLite.json({ schema: Schema.Array(CodeableConcept.Schema) }),
  code: State.SQLite.json({ schema: CodeableConcept.Schema }),
  component: State.SQLite.json({
    schema: Schema.Array(ObservationComponent.Schema).pipe(
      AnnotateArrayWithArbitrary({ maxLength: 2 })
    ),
  }),
  dataAbsentReason: State.SQLite.json({ nullable: true, schema: CodeableConcept.Schema }),
  derivedFrom: State.SQLite.json({
    schema: Schema.Array(Reference.Schema).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 })),
  }),
  device: State.SQLite.json({ nullable: true, schema: Reference.Schema }),
  // FHIR R4 `Observation.effective[x]`: choice of `dateTime | Period |
  // Timing | instant`. Using the column helper keeps storage parallel with
  // `value[x]` below; mutex enforcement is not implemented (see Capability
  // Statement.md).
  ...ChoiceElementSet.Columns(
    'effective',
    ChoiceElementSet.FhirR4SetChoices['Observation.effective[x]']
  ),
  encounter: State.SQLite.json({ nullable: true, schema: Reference.Schema }),
  focus: State.SQLite.json({
    schema: Schema.Array(Reference.Schema).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 })),
  }),
  hasMember: State.SQLite.json({
    schema: Schema.Array(Reference.Schema).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 })),
  }),
  identifier: State.SQLite.json({
    schema: Schema.Array(Identifier.Schema).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 })),
  }),
  interpretation: State.SQLite.json({
    schema: Schema.Array(CodeableConcept.Schema).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 })),
  }),
  issued: State.SQLite.text({ nullable: true, schema: Schema.DateTimeUtc }),
  method: State.SQLite.json({ nullable: true, schema: CodeableConcept.Schema }),
  note: State.SQLite.json({
    schema: Schema.Array(Annotation.Schema).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 })),
  }),
  partOf: State.SQLite.json({
    schema: Schema.Array(Reference.Schema).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 })),
  }),
  performer: State.SQLite.json({
    schema: Schema.Array(Reference.Schema).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 })),
  }),
  referenceRange: State.SQLite.json({
    schema: Schema.Array(ObservationReferenceRange.Schema).pipe(
      AnnotateArrayWithArbitrary({ maxLength: 2 })
    ),
  }),
  specimen: State.SQLite.json({ nullable: true, schema: Reference.Schema }),
  status: State.SQLite.text({ schema: StatusSchema }),
  subject: State.SQLite.json({ nullable: true, schema: Reference.Schema }),
  ...ChoiceElementSet.Columns('value', ChoiceElementSet.FhirR4SetChoices['Observation.value[x]']),
} as const

const table = State.SQLite.table({ name: resourceType, columns })

const { RowSchema: BaseRowSchema, RowSchemaNullableId } = makeRowSchemas(columns, {
  name: resourceType,
})

// Normalize arbitrary values through an encode/decode roundtrip so optional
// fields collapse `undefined` to their decode default (e.g. `null` for
// `OrNullAsOptional`) and JSON-passthrough columns shed any non-JSON values.
// Without this, the raw arbitrary produces values that aren't equal to their
// post-roundtrip form, even though the schema considers them equivalent.
const RowSchema = BaseRowSchema.annotations({
  arbitrary: () => (_fc: typeof FastCheck) =>
    Arbitrary.make(BaseRowSchema).map((obs) =>
      Schema.decodeSync(BaseRowSchema)(Schema.encodeSync(BaseRowSchema)(obs))
    ),
})

const { events, materializers, queries } = makeDomainResourcePersistence({
  table,
  rowSchema: RowSchema,
})

export {
  events,
  materializers,
  queries,
  resourceType,
  RowSchema,
  RowSchemaNullableId,
  StatusSchema,
  table,
}
export type { Status }
export * as Component from './observation-component.ts'
export * as ReferenceRange from './observation-reference-range.ts'
