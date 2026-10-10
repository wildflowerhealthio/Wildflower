import { Either, ParseResult, type Schema } from 'effect'

import type { ArrayElementsCheck } from './filter-array-with-every-check.ts'

/**
 * Checks an array holds exactly one element that `matches`, that element
 * satisfying `schema`'s type: one issue at the array when none or several
 * match, else the matching element's own issues against `schema`, at its
 * index.
 *
 * @remarks
 * Matching and validity are separate so a well-matched but malformed element
 * (a `load` order detail holding a negative load) is reported as itself, not
 * as missing. A duplicate is refused rather than read as "the first".
 */
const checkArrayHasOneMatchingElement = <A>({
  matches,
  schema,
  expected,
}: {
  /** Which elements are candidates, e.g. the concepts coded `load`. */
  readonly matches: (element: A) => boolean
  /** What the one candidate must satisfy. */
  readonly schema: Schema.Schema.AnyNoContext
  /** What the candidate is, for the message: `exercise concept`. */
  readonly expected: string
}): ArrayElementsCheck<A> => {
  const validate = ParseResult.validateEither(schema, { errors: 'all' })
  return (elements) => {
    const indices = elements.flatMap((element, index) => (matches(element) ? [index] : []))
    const [index] = indices
    return indices.length === 1 && index !== undefined
      ? Either.match(validate(elements[index]), {
          onRight: () => undefined,
          onLeft: (issue) => new ParseResult.Pointer(index, elements, issue),
        })
      : `expected exactly one ${expected}, found ${indices.length}`
  }
}

export { checkArrayHasOneMatchingElement }
