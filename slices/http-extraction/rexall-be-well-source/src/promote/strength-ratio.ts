import { ParseResult, Schema } from 'effect'

import { Ratio } from 'fhir-r4/data-types'

/** A leading decimal number (`.` only — see {@link StrengthRatioFromString}), then a unit word. */
const STRENGTH_PATTERN = /^\s*(\d+(?:\.\d+)?)\s*([A-Za-z][A-Za-z/%.-]*)\s*$/

/**
 * `"10 mg"` / `"500MG"` → a wire `Ratio` of 10 mg per 1 unit of product.
 * Anything that is not a leading number followed by a unit word fails to
 * decode, so an unparseable strength keeps its extension instead of being
 * dropped.
 *
 * @remarks
 * `.` is the only decimal separator accepted. Rexall is an English-Canadian
 * pharmacy, where `"1,000 mg"` is one thousand milligrams written with a
 * thousands separator — reading that comma as a decimal point would silently
 * record a 1000× under-dose. Such a string simply fails to decode, which
 * leaves the extension in place with its true value intact.
 */
const StrengthRatioFromString = Schema.transformOrFail(
  Schema.String,
  Schema.encodedSchema(Ratio.Schema),
  {
    strict: true,
    decode: (raw, _, ast) => {
      const [, amount, unit] = STRENGTH_PATTERN.exec(raw) ?? []
      const value = Number(amount)
      return amount === undefined || unit === undefined || !Number.isFinite(value)
        ? ParseResult.fail(new ParseResult.Type(ast, raw, 'not a `<number> <unit>` strength'))
        : ParseResult.succeed({ numerator: { value, unit }, denominator: { value: 1 } })
    },
    encode: (ratio, _, ast) =>
      ratio.numerator?.value === undefined || ratio.numerator.unit === undefined
        ? ParseResult.fail(new ParseResult.Type(ast, ratio, 'a strength needs a value and a unit'))
        : ParseResult.succeed(`${ratio.numerator.value} ${ratio.numerator.unit}`),
  }
)

export { StrengthRatioFromString }
