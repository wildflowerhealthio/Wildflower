import type { Effect, ParseResult, SchemaAST } from 'effect'
import { parseWithSourceIdentity, type SourceKeyedResource } from 'fhir-r4/identity'

/**
 * Rexall's identity as an assigner of ids — the one fact this package states
 * about re-keying. Why resources are re-keyed at all, and everything it
 * involves, is `fhir-r4`'s `identity` module.
 *
 * @packageDocumentation
 */

/**
 * Rexall Be Well as the assigner of every id this collector re-keys.
 *
 * @remarks
 * `letsbewell.ca` is the site the user signs into, not a URL this collector
 * ever fetches — the tunnel host (`rexall-prd-tunnel.letsbewell.ca`) encodes a
 * deployment that could be renamed without the user's prescriptions becoming
 * different prescriptions, and a derived id must not move when it is.
 *
 * Module-level, so both entities re-key against one namespace and
 * `ProfileEntity`'s `Patient` stays the resource `MedicationListEntity`'s
 * `subject` references. Two accounts on one device therefore share it: for a
 * record they both hold that is an upsert, not a collision.
 */
const RexallSource = {
  prefix: 'rexall',
  system: new URL('https://letsbewell.ca'),
} as const

/**
 * Re-key everything one response produced onto the store's namespace.
 *
 * @param ast - The schema the entity was decoding, for the failure message
 * @param resources - The decoded resources, as the entity produced them
 * @returns The same resources, re-keyed against {@link RexallSource}
 */
const withSourceIdentity = <TResource extends SourceKeyedResource>(
  ast: SchemaAST.AST,
  resources: readonly TResource[]
): Effect.Effect<readonly TResource[], ParseResult.ParseError> =>
  parseWithSourceIdentity(RexallSource, ast, resources)

export { RexallSource, withSourceIdentity }
