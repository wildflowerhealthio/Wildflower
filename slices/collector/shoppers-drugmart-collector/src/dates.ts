import { Option, Schema } from 'effect'

const decodeDateTime = Schema.decodeUnknownOption(Schema.DateTimeUtc)

/**
 * True iff `value` decodes as a FHIR R4 date-time (so it can ride a wire slot).
 * A date-only string (`YYYY-MM-DD`, which the portal uses for fill/dispense
 * dates) decodes as midnight UTC, so it passes; a malformed one does not, and
 * the caller omits just that slot rather than failing the whole resource decode.
 */
const decodesAsDateTime = (value: string | undefined): value is string =>
  value != null && Option.isSome(decodeDateTime(value))

/** The first of `values` that decodes as a FHIR date-time, else `undefined`. */
const firstDateTime = (...values: Array<string | undefined>): string | undefined =>
  values.find(decodesAsDateTime)

export { decodesAsDateTime, firstDateTime }
