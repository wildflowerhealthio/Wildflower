import { Array } from 'effect'

import * as TokenSearchParam from './token-search-param.ts'

/**
 * A FHIR R4 `string` search-parameter value (§ search.html#string): text a
 * name or address part starts with, with several of them comma-joined to
 * match any one.
 *
 * @remarks
 * The spec reserves `,` (or), `|`, `$` and `\` in every search value, a
 * string's as much as a token's, so a literal value that carries one of them
 * is escaped with a backslash before it goes on the wire
 * (§ search.html#escaping): a family of `Smith, Jr` is otherwise read as
 * `Smith` or `Jr`. The `string` parameters the typed client declares (`name`,
 * `family`, `given`) are passed through as written, so that a caller can send
 * `a,b` to mean either, and a caller with one literal value escapes it here.
 *
 * @packageDocumentation
 */

/** `raw` with every reserved character escaped by a backslash, so the server reads it as one literal value. */
const escape: (raw: string) => string = TokenSearchParam.escape

/**
 * `values` as one `string` search value matching a resource any one of them
 * matches: each escaped ({@link escape}), then comma-joined.
 */
const anyOf = (values: Array.NonEmptyReadonlyArray<string>): string =>
  Array.join(Array.map(values, escape), ',')

export { anyOf, escape }
