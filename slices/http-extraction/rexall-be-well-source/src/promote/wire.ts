import { Schema } from 'effect'

/**
 * Schemas for raw wire JSON that reaches promotion undecoded — `contained` is
 * untyped passthrough on the decoded R4 resources.
 *
 * @remarks
 * Declared here rather than taken from `fhir-r4`: a raw entry's `system` is a
 * string, not the decoded `URL`, and keys the R4 schemas do not model must
 * survive the round trip. A nullable key decodes to an `Option`, whether the
 * wire spells its absence as a missing key or an explicit `null`; `None`
 * encodes back as a missing key, since FHIR JSON has no `null` values.
 */

/**
 * The rest of a raw wire object: every key a schema does not name is carried
 * through untouched, so re-emitting a decoded entry loses nothing.
 */
const OtherWireFields = Schema.Record({ key: Schema.String, value: Schema.Unknown })

/** A wire string that may be missing or `null`, decoded to an `Option`. */
const WireStringOption = Schema.optionalWith(Schema.String, { nullable: true, as: 'Option' })

/** A raw `Coding`. */
const WireCoding = Schema.Struct(
  { system: WireStringOption, code: WireStringOption, display: WireStringOption },
  OtherWireFields
)
type WireCoding = typeof WireCoding.Type

/** A raw `CodeableConcept`. */
const WireCodeableConcept = Schema.Struct(
  {
    text: WireStringOption,
    coding: Schema.optionalWith(Schema.Array(WireCoding), { as: 'Option' }),
  },
  OtherWireFields
)
type WireCodeableConcept = typeof WireCodeableConcept.Type

export { OtherWireFields, WireCodeableConcept, WireCoding, WireStringOption }
