import { Array as Arr, Either, Schema } from 'effect'
import type { ParseError } from 'effect/ParseResult'

/**
 * One patient the settings page offers to pick: as much of a FHIR `Patient` as
 * the page shows and the watch receives — the id, the names, the birth date —
 * read leniently out of a `Patient` search.
 *
 * @remarks
 * A namespace module — consumers speak `PatientSummary.Type` and read a search
 * response with `PatientSummary.fromSearchBundle`.
 *
 * Lenient on purpose, and local rather than `fhir-r4`'s `Patient.Schema`,
 * because the page lists whatever server the user signed in to. The strict
 * schema refuses legal FHIR the watch has no use for being strict about (a
 * partial `birthDate` like `1970` or `1970-05`), and a strict `Bundle` decode
 * fails the whole list for one such patient. Here each entry decodes on its
 * own: an entry that does not read as a patient with an id is left out, and
 * the rest are listed. Each name decodes on its own too, and `given`'s `null`
 * placeholders are dropped. The birth date is carried as the string the server
 * wrote, which is also what the watch shows.
 *
 * @packageDocumentation
 */

/**
 * `HumanName.given` with FHIR's `null` placeholders dropped. A JSON array may
 * hold `null` where a part has only an extension (paired with `_given`); the
 * name the display rule renders is the parts that are there.
 */
const GivenParts = Schema.transform(
  Schema.Array(Schema.NullOr(Schema.String)),
  Schema.Array(Schema.String),
  {
    strict: true,
    decode: (parts) => parts.filter((part): part is string => part !== null),
    encode: (parts) => parts,
  }
)

/**
 * A `HumanName` as loosely as the display rule reads it — `fhir-r4`'s
 * `HumanName.displayName` takes exactly these fields, so a summary's names go
 * straight to it.
 */
const LooseHumanName = Schema.Struct({
  use: Schema.optional(Schema.NullOr(Schema.String)),
  given: Schema.optional(Schema.NullOr(GivenParts)),
  family: Schema.optional(Schema.NullOr(Schema.String)),
  text: Schema.optional(Schema.NullOr(Schema.String)),
  period: Schema.optional(
    Schema.NullOr(Schema.Struct({ end: Schema.optional(Schema.NullOr(Schema.String)) }))
  ),
})

const decodeName = Schema.decodeUnknownOption(LooseHumanName)

/**
 * A record's names, each decoded on its own: a name that does not read as a
 * {@link LooseHumanName} is left out, and the patient keeps the rest — one
 * malformed name must not cost the whole patient.
 */
const LooseHumanNames = Schema.transform(
  Schema.Array(Schema.Unknown),
  Schema.Array(Schema.typeSchema(LooseHumanName)),
  {
    strict: true,
    decode: (names) => Arr.filterMap(names, (name) => decodeName(name)),
    encode: (names) => names,
  }
)

const PatientSummarySchema = Schema.Struct({
  resourceType: Schema.Literal('Patient'),
  /** The patient's logical id — what the watch writes each Observation's `subject` against. */
  id: Schema.NonEmptyString,
  /** The record's readable names in record order; `[]` when it has none. */
  name: Schema.optionalWith(LooseHumanNames, { default: () => [] }),
  /** The birth date as the server wrote it (`1815-12-10`, `1815-12`, `1815`); `null` when absent. */
  birthDate: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
})

/** One patient as the settings page lists it. */
type Type = typeof PatientSummarySchema.Type

/**
 * A `searchset` page, as permissively as it can be read: only `entry[].resource`
 * matters, and a page with no `entry` is an empty list.
 */
const SearchBundle = Schema.Struct({
  resourceType: Schema.Literal('Bundle'),
  entry: Schema.optional(
    Schema.NullOr(Schema.Array(Schema.Struct({ resource: Schema.optional(Schema.Unknown) })))
  ),
})

const decodeSearchBundle = Schema.decodeUnknownEither(SearchBundle)
const decodeSummary = Schema.decodeUnknownOption(PatientSummarySchema)

/**
 * The patients a `Patient` search response lists, in server order.
 *
 * @param response - The search response body, as parsed JSON
 * @returns The entries that read as a patient with an id, or the `ParseError`
 *   when `response` is not a `Bundle` at all
 *
 * @remarks
 * An entry that does not decode — no id, or a field of the wrong type — is
 * dropped rather than failing the list, and so is an entry that is not a
 * `Patient` (a server may add an `OperationOutcome` to a search page). Within
 * a patient, a malformed name drops only that name. A
 * response that is not a bundle fails: that is the server answering something
 * other than the search, and the page says so rather than showing no patients.
 */
const fromSearchBundle = (response: unknown): Either.Either<readonly Type[], ParseError> =>
  Either.map(decodeSearchBundle(response), (bundle) =>
    Arr.filterMap(bundle.entry ?? [], (entry) => decodeSummary(entry.resource))
  )

export { fromSearchBundle, PatientSummarySchema as Schema }
export type { Type }
