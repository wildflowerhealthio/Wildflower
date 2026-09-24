import { Schema } from 'effect'

/**
 * Schemas for raw wire JSON that reaches promotion undecoded — `contained` is
 * untyped passthrough on the decoded R4 resources.
 *
 * @remarks
 * Declared here rather than taken from `fhir-r4`: a raw entry's `system` is a
 * string, not the decoded `URL`, it may carry explicit `null`s, and keys the R4
 * schemas do not model must survive the round trip.
 */

/**
 * The rest of a raw wire object: every key a schema does not name is carried
 * through untouched, so re-emitting a decoded entry loses nothing.
 */
const OtherWireFields = Schema.Record({ key: Schema.String, value: Schema.Unknown })

/** An optional, nullable wire string — raw passthrough JSON may spell absence either way. */
const OptionalWireString = Schema.optional(Schema.NullOr(Schema.String))

/** A raw `Coding`. */
const WireCoding = Schema.Struct(
  { system: OptionalWireString, code: OptionalWireString, display: OptionalWireString },
  OtherWireFields
)

/** A raw `CodeableConcept`. */
const WireCodeableConcept = Schema.Struct(
  { text: OptionalWireString, coding: Schema.optional(Schema.Array(WireCoding)) },
  OtherWireFields
)
type WireCodeableConcept = typeof WireCodeableConcept.Type

export { OptionalWireString, OtherWireFields, WireCodeableConcept }
