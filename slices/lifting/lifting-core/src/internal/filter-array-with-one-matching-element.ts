import { Either, Option, ParseResult, pipe, Schema, SchemaAST } from 'effect'

/** A filter an array schema is piped through, keeping its type. */
type ArrayFilter<A> = <I, R>(
  self: Schema.Schema<readonly A[], I, R>
) => Schema.Schema<readonly A[], I, R>

/** Marks a refinement {@link filterArrayWithOneMatchingElement} made, for the next one piped onto it to join. */
const JoinsOneMatchingElementFilters: unique symbol = Symbol.for(
  'lifting-core/JoinsOneMatchingElementFilters'
)

/** `ast` as a refinement {@link filterArrayWithOneMatchingElement} made; `None` for any other. */
const oneMatchingElementRefinementOf = (ast: SchemaAST.AST): Option.Option<SchemaAST.Refinement> =>
  pipe(
    Option.liftPredicate(ast, SchemaAST.isRefinement),
    Option.filter((refinement) =>
      Option.getOrElse(
        SchemaAST.getAnnotation<boolean>(JoinsOneMatchingElementFilters)(refinement),
        () => false
      )
    )
  )

/**
 * Filters an array to hold exactly one element that `matches`, that element
 * satisfying `schema`'s type: one issue at the array when none or several
 * match, else the matching element's own issues against `schema`, at its
 * index.
 *
 * @remarks
 * Matching and validity are separate so a well-matched but malformed element
 * (a `load` order detail holding a negative load) is reported as itself, not
 * as missing. A duplicate is refused rather than read as "the first".
 *
 * Piped onto another filter made here, the two check as one refinement — an
 * array that must hold one `sets` and one `reps` concept names a bad `sets`
 * and a bad `reps` at once, where a refinement piped onto a failing one
 * would never run.
 */
const filterArrayWithOneMatchingElement = <A>({
  matches,
  schema,
  expected,
}: {
  /** Which elements are candidates, e.g. the concepts coded `load`. */
  readonly matches: (element: A) => boolean
  /** What the one candidate must satisfy. */
  readonly schema: Schema.Schema.AnyNoContext
  /** What the candidate is, for the message: `"load" order detail`. */
  readonly expected: string
}): ArrayFilter<A> => {
  const validate = ParseResult.validateEither(schema, { errors: 'all' })
  const issueOf = (elements: readonly A[]): Schema.FilterOutput => {
    const indices = elements.flatMap((element, index) => (matches(element) ? [index] : []))
    const [index] = indices
    return indices.length === 1 && index !== undefined
      ? Either.match(validate(elements[index]), {
          onRight: () => undefined,
          onLeft: (issue) => new ParseResult.Pointer(index, elements, issue),
        })
      : `expected exactly one ${expected}, found ${indices.length}`
  }
  return <I, R>(self: Schema.Schema<readonly A[], I, R>): Schema.Schema<readonly A[], I, R> =>
    Option.match(oneMatchingElementRefinementOf(self.ast), {
      onNone: () => self.pipe(Schema.filter(issueOf, { [JoinsOneMatchingElementFilters]: true })),
      onSome: (earlier) =>
        Schema.make<readonly A[], I, R>(earlier.from).pipe(
          Schema.filter(
            (elements, options) => [
              ...Option.toArray(earlier.filter(elements, options, earlier)),
              issueOf(elements),
            ],
            { [JoinsOneMatchingElementFilters]: true }
          )
        ),
    })
}

export { filterArrayWithOneMatchingElement }
export type { ArrayFilter }
