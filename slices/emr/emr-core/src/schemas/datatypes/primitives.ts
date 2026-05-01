import { Schema } from 'effect'

// ---------------------------------------------------------------------------
// Strict primitive schemas
// ---------------------------------------------------------------------------

/** FHIR R4 `time`: `hh:mm:ss[.fff]` with leap-second tolerance. */
const TimeSchema = Schema.String.pipe(
  Schema.pattern(/^([01][0-9]|2[0-3]):[0-5][0-9]:([0-5][0-9]|60)(\.[0-9]{1,9})?$/)
)

/** FHIR R4 `uri`/`url`/`canonical`: any non-whitespace string per spec regex. */
const UriSchema = Schema.String.pipe(Schema.pattern(/^\S*$/))

/** FHIR R4 `id`: 1-64 chars of `[A-Za-z0-9\-.]`. */
const IdSchema = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9\-.]{1,64}$/))

export { IdSchema, TimeSchema, UriSchema }
