import { ParseResult, Schema } from 'effect'

import { Period } from './period.ts'

const ResourceType = 'HumanName'

const fields = {
  /**
   * Identifies the purpose for this name.
   * usual | official | temp | nickname | anonymous | old | maiden
   */
  use: Schema.UndefinedOr(
    Schema.Union(
      Schema.Literal('usual'),
      Schema.Literal('official'),
      Schema.Literal('temp'),
      Schema.Literal('nickname'),
      Schema.Literal('anonymous'),
      Schema.Literal('old'),
      Schema.Literal('maiden')
    )
  ).pipe(Schema.optionalWith({ default: () => undefined })),
  /**
   * Specifies the entire name as it should be displayed e.g. on an application UI. This may be provided instead of or as well as the specific parts.
   */
  text: Schema.UndefinedOr(Schema.String).pipe(Schema.optionalWith({ default: () => undefined })),
  /**
   * The part of a name that links to the genealogy. In some cultures (e.g. Eritrea) the family name of a son is the first name of his father.
   */
  family: Schema.Union(
    Schema.UndefinedOr(Schema.String),
    Schema.transformOrFail(Schema.Array(Schema.String), Schema.UndefinedOr(Schema.String), {
      strict: true,
      decode: (arr, _options, ast) => {
        if (arr.length === 0) return ParseResult.succeed(undefined)
        if (arr.length === 1) return ParseResult.succeed(arr[0])
        return ParseResult.fail(
          new ParseResult.Type(ast, arr, `Expected at most one family name, got ${arr.length}`)
        )
      },
      encode: (str) => {
        if (str === undefined) return ParseResult.succeed([])
        return ParseResult.succeed([str])
      },
    })
  ).pipe(Schema.optionalWith({ default: () => undefined })),
  /**
   * Given name.
   */
  given: Schema.UndefinedOr(Schema.Array(Schema.String)).pipe(
    Schema.optionalWith({ default: () => undefined })
  ),
  /**
   * Part of the name that is acquired as a title due to academic, legal, employment or nobility status, etc. and that appears at the start of the name.
   */
  prefix: Schema.UndefinedOr(Schema.Array(Schema.String)).pipe(
    Schema.optionalWith({ default: () => undefined })
  ),
  /**
   * Part of the name that is acquired as a title due to academic, legal, employment or nobility status, etc. and that appears at the end of the name.
   */
  suffix: Schema.UndefinedOr(Schema.Array(Schema.String)).pipe(
    Schema.optionalWith({ default: () => undefined })
  ),
  /**
   * Indicates the period of time when this name was valid for the named person.
   */
  period: Schema.UndefinedOr(Schema.suspend(() => Period)).pipe(
    Schema.optionalWith({ default: () => undefined })
  ),
} as const

/** Encoded (wire-format) shape of a {@link HumanName}. */
export interface HumanNameEncoded extends Schema.Struct.Encoded<typeof fields> {}

/**
 * A human's name with the ability to identify parts and usage.
 */
export class HumanName extends Schema.Class<HumanName>(ResourceType)(fields) {
  static readonly ResourceType = ResourceType
}
