import { Arbitrary, type FastCheck, Schema } from 'effect'

import { AnnotateArrayWithArbitrary, PermissivePassthrough } from 'kitchen-sink/schema'

import { State } from '@livestore/livestore'
import { makeRowSchemas } from '../internal/make-row-schemas.ts'
import * as Annotation from '../schemas/complex/annotation.ts'
import * as CodeableConcept from '../schemas/complex/codeable-concept.ts'
import * as Identifier from '../schemas/complex/identifier.ts'
import * as Reference from '../schemas/complex/reference.ts'
import * as DatatypeChoice from '../schemas/datatype-choice.ts'
import FhirR4ChoiceElements from '../schemas/fhir-r4-choice-elements.ts'
import * as DomainResource from './domain-resource.ts'
import * as ObservationComponent from './observation-component.ts'
import * as ObservationReferenceRange from './observation-reference-range.ts'

/**
 * The status of the result value.
 */
const ObservationStatus = Schema.Enums({
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
type ObservationStatus = typeof ObservationStatus.Type

const resourceType = 'Observation' as const

const observationValue = DatatypeChoice.DatatypeChoice(
  'value',
  FhirR4ChoiceElements['Observation.value[x]']
)

const fields = {
  resourceType: Schema.Literal(resourceType),
  basedOn: Schema.Array(Reference.Schema).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 })),
  bodySite: Schema.NullOr(CodeableConcept.Schema),
  category: Schema.Array(CodeableConcept.Schema),
  code: CodeableConcept.Schema,
  component: Schema.Array(ObservationComponent.Schema).pipe(
    AnnotateArrayWithArbitrary({ maxLength: 2 })
  ),
  dataAbsentReason: Schema.NullOr(CodeableConcept.Schema),
  derivedFrom: Schema.Array(Reference.Schema).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 })),
  device: Schema.NullOr(Reference.Schema),
  effectiveDateTime: Schema.NullOr(Schema.DateTimeUtc),
  encounter: Schema.NullOr(Reference.Schema),
  focus: Schema.Array(Reference.Schema).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 })),
  hasMember: Schema.Array(Reference.Schema).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 })),
  identifier: Schema.Array(Identifier.Schema).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 })),
  interpretation: Schema.Array(CodeableConcept.Schema).pipe(
    AnnotateArrayWithArbitrary({ maxLength: 2 })
  ),
  issued: Schema.NullOr(Schema.DateTimeUtc),
  method: Schema.NullOr(CodeableConcept.Schema),
  note: Schema.Array(Annotation.Schema).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 })),
  partOf: Schema.Array(Reference.Schema).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 })),
  performer: Schema.Array(Reference.Schema).pipe(AnnotateArrayWithArbitrary({ maxLength: 2 })),
  referenceRange: Schema.Array(ObservationReferenceRange.Schema).pipe(
    AnnotateArrayWithArbitrary({ maxLength: 2 })
  ),
  specimen: Schema.NullOr(Reference.Schema),
  status: ObservationStatus,
  subject: Schema.NullOr(Reference.Schema),
  ...observationValue.fields,
} as const

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
  effectiveDateTime: State.SQLite.text({ nullable: true, schema: Schema.DateTimeUtc }),
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
  status: State.SQLite.text({ schema: ObservationStatus }),
  subject: State.SQLite.json({ nullable: true, schema: Reference.Schema }),
  valueQuantity: State.SQLite.json({ nullable: true, schema: PermissivePassthrough }),
  valueCodeableConcept: State.SQLite.json({ nullable: true, schema: PermissivePassthrough }),
  valueString: State.SQLite.text({ nullable: true }),
  valueBoolean: State.SQLite.boolean({ nullable: true }),
  valueInteger: State.SQLite.integer({ nullable: true, schema: Schema.Int }),
  valueRange: State.SQLite.json({ nullable: true, schema: PermissivePassthrough }),
  valueRatio: State.SQLite.json({ nullable: true, schema: PermissivePassthrough }),
  valueSampledData: State.SQLite.json({ nullable: true, schema: PermissivePassthrough }),
  valueTime: State.SQLite.text({ nullable: true }),
  valueDateTime: State.SQLite.text({ nullable: true, schema: Schema.DateTimeUtc }),
  valuePeriod: State.SQLite.json({ nullable: true, schema: PermissivePassthrough }),
} as const

const table = State.SQLite.table({ name: resourceType, columns })

const { RowSchema: BaseRowSchema, RowSchemaOptionalId } = makeRowSchemas(columns, {
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

export { ObservationStatus, resourceType, fields, table, RowSchema, RowSchemaOptionalId }
