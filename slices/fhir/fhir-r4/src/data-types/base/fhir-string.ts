import { type Arbitrary, type FastCheck, ParseResult, Schema } from 'effect'

import { OrNullAsOptional } from '@wildflowerhealthio/kitchen-sink/schema'

/**
 * True when `value` holds no non-whitespace character: `''`, `'   '`, `'\n\t'`.
 * FHIR R4 forbids an empty primitive value; this client treats a
 * whitespace-only `string` or `markdown` the same way. Exported so a reader of
 * raw wire JSON judges blank by the same rule decode does.
 */
const isBlank = (value: string): boolean => !/\S/.test(value)

// Printable ASCII without the space: every character here is non-whitespace,
// so a value that holds one is non-blank by construction.
const nonWhitespaceCharArbitrary = (fc: typeof FastCheck): FastCheck.Arbitrary<string> =>
  fc.integer({ min: 0x21, max: 0x7e }).map((code) => String.fromCharCode(code))

/**
 * FHIR R4 `string` / `markdown` for a required element: a string holding at
 * least one non-whitespace character. A blank value fails decode and encode.
 * A non-blank value is kept verbatim, surrounding whitespace included, so it
 * round-trips byte for byte.
 *
 * @remarks
 * The `arbitrary` annotation inserts a non-whitespace character into an
 * arbitrary string, so property tests over any schema embedding this one never
 * generate a blank value and never lean on fast-check filtering, while the
 * values stay about as long as plain `Schema.String`'s.
 */
const FhirStringSchema = Schema.String.pipe(
  Schema.filter((value) => !isBlank(value), {
    identifier: 'FhirString',
    description: 'a FHIR string with at least one non-whitespace character',
  }),
  Schema.annotations({
    arbitrary: (): Arbitrary.LazyArbitrary<string> => (fc: typeof FastCheck) =>
      fc
        .tuple(fc.string(), nonWhitespaceCharArbitrary(fc), fc.nat())
        .map(([text, nonWhitespace, position]) => {
          const at = position % (text.length + 1)
          return `${text.slice(0, at)}${nonWhitespace}${text.slice(at)}`
        }),
  })
)

/**
 * Wire `string` to `string | null`: a blank value decodes to `null`, any other
 * value is kept verbatim. Encode fails on a blank value (the
 * {@link FhirStringSchema} refinement) and on `null`, which has no wire string;
 * a field built on it writes `null` as absent before this runs. It is the
 * datatype registry's `string` schema, which choice slots wrap in
 * `OrNullAsOptional`.
 */
const BlankAsNull = Schema.transformOrFail(Schema.String, Schema.NullOr(FhirStringSchema), {
  strict: true,
  decode: (wire) => ParseResult.succeed(isBlank(wire) ? null : wire),
  encode: (value, _options, ast) =>
    value === null
      ? ParseResult.fail(
          new ParseResult.Type(ast, value, 'null has no FHIR string; write it as absent')
        )
      : ParseResult.succeed(value),
})

/**
 * Field for an optional FHIR `string` / `markdown` element. Absent and blank
 * both decode to `null`; `null` encodes as absent, and a blank value fails
 * encode.
 */
const Optional = OrNullAsOptional(BlankAsNull)

/**
 * Repeating FHIR `string` element (`HumanName.given`, `Address.line`). Decode
 * drops blank items; encode fails on a blank item.
 */
const FhirStringArray = Schema.transform(
  Schema.Array(Schema.String),
  Schema.Array(FhirStringSchema),
  {
    strict: true,
    decode: (items) => items.filter((item) => !isBlank(item)),
    encode: (items) => items,
  }
)

export { BlankAsNull, FhirStringArray as Array, FhirStringSchema as Schema, isBlank, Optional }
