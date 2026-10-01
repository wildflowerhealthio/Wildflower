import { ParseResult } from 'effect'

/** One problem a `make` refused with: where in what it made, and why. */
interface ParseIssue {
  /** The path into the made resource, e.g. `["action", 1, "title"]`. */
  readonly path: readonly PropertyKey[]
  /** Why, as `lifting-core`'s schema words it. */
  readonly message: string
}

/** Every issue of a refused `make`, each at its path. */
const parseIssuesOf = (parseError: ParseResult.ParseError): readonly ParseIssue[] =>
  ParseResult.ArrayFormatter.formatErrorSync(parseError)

export { parseIssuesOf }
export type { ParseIssue }
