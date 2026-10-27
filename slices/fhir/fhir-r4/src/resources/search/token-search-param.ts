import { Array } from 'effect'

import type { IdentifierAndReference } from '../../data-types/index.ts'

/**
 * A FHIR R4 `token` search-parameter value (§ search.html#token): a code or
 * identifier, as `system|value` or a bare `value`, with several of them
 * comma-joined to match any one.
 *
 * @remarks
 * The spec reserves `,` (or), `|` (the system separator), `$` and `\` in a
 * search value, so a system or value that carries one of them is escaped with
 * a backslash before it goes on the wire (§ search.html#escaping). The
 * `identifier` parameter the typed client declares is passed through as
 * written, so a caller builds the value here.
 *
 * @packageDocumentation
 */

/** The characters FHIR search reserves in a value: `\`, `,`, `$` and `|`. */
const RESERVED_CHARACTER = /[\\,$|]/gu

/** `raw` with every reserved character escaped by a backslash, so it is read literally. */
const escape = (raw: string): string => raw.replaceAll(RESERVED_CHARACTER, '\\$&')

/** `identifier` as a token value, `system|value`, each half escaped. */
const fromQualifiedIdentifier = ({
  system,
  value,
}: IdentifierAndReference.QualifiedIdentifierType): string =>
  `${escape(system.href)}|${escape(value)}`

/** One value matching any of `tokens`: the tokens comma-joined. */
const anyOf = (tokens: Array.NonEmptyReadonlyArray<string>): string => Array.join(tokens, ',')

export { anyOf, escape, fromQualifiedIdentifier }
