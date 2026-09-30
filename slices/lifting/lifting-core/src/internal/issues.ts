import { Either, Option, ParseResult, type Schema } from 'effect'

/** Each schema's validator, compiled once: compiling one per call is what a refinement run per element would otherwise pay. */
const validators = new WeakMap<
  Schema.Schema.AnyNoContext,
  (value: unknown) => Either.Either<unknown, ParseResult.ParseIssue>
>()

/** `schema`'s type validator, reporting every issue. */
const validatorOf = (
  schema: Schema.Schema.AnyNoContext
): ((value: unknown) => Either.Either<unknown, ParseResult.ParseIssue>) => {
  const known = validators.get(schema)
  if (known !== undefined) return known
  const validator = ParseResult.validateEither(schema, { errors: 'all' })
  validators.set(schema, validator)
  return validator
}

/**
 * `value`'s own issues against `schema`'s type, each under `path` — so a
 * refinement on a whole resource reports a part's problems where the part is.
 */
const issuesAt = (part: {
  /** What the part must satisfy. */
  readonly schema: Schema.Schema.AnyNoContext
  /** The part. */
  readonly value: unknown
  /** Where the part is in the value being refined. */
  readonly path: readonly PropertyKey[]
}): readonly Schema.FilterIssue[] =>
  Either.match(validatorOf(part.schema)(part.value), {
    onRight: () => [],
    onLeft: (issue) =>
      ParseResult.ArrayFormatter.formatIssueSync(issue).map((formatted) => ({
        path: [...part.path, ...formatted.path],
        message: formatted.message,
      })),
  })

/**
 * The issues of a list that must hold exactly one `selected` item, that item
 * satisfying `schema`: one issue at `path` when none or several are selected,
 * else the selected item's own issues at its index.
 *
 * @remarks
 * Selection and validity are separate so a well-selected but malformed item
 * (a `load` order detail holding a negative load) is reported as itself, not
 * as missing. A duplicate is refused rather than read as "the first".
 */
const onlyOneIssues = <A>(spec: {
  /** The list, e.g. a `ServiceRequest.orderDetail`. */
  readonly items: readonly A[]
  /** Which items are candidates, e.g. the concepts coded `load`. */
  readonly selected: (item: A) => boolean
  /** What the one candidate must satisfy. */
  readonly schema: Schema.Schema.AnyNoContext
  /** Where the list is in the value being refined. */
  readonly path: readonly PropertyKey[]
  /** What the candidate is, for the message: `a "load" order detail`. */
  readonly expected: string
}): readonly Schema.FilterIssue[] => {
  const indices = spec.items.flatMap((item, index) => (spec.selected(item) ? [index] : []))
  const [index] = indices
  return indices.length === 1 && index !== undefined
    ? issuesAt({ schema: spec.schema, value: spec.items[index], path: [...spec.path, index] })
    : [
        {
          path: spec.path,
          message: `expected exactly one ${spec.expected}, found ${indices.length}`,
        },
      ]
}

/**
 * The value a narrowed schema guarantees is there.
 *
 * @remarks
 * A getter on a decoded narrowed type reads through a finder that returns an
 * `Option`; the schema admitted the value only because that finder found
 * something, so `None` here means a value that never went through the schema —
 * a defect, not an input error — and throws.
 */
const guaranteed = <A>(found: Option.Option<A>): A =>
  Option.getOrThrowWith(
    found,
    () => new Error('a narrowed value is missing what its schema guarantees; was it decoded?')
  )

export { guaranteed, onlyOneIssues }
