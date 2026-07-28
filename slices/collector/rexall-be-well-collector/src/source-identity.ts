import type { Effect, ParseResult, SchemaAST } from 'effect'
import { parseWithSourceIdentity, type SourceKeyedResource } from 'fhir-r4/identity'

/**
 * Rexall's identity as an assigner of ids.
 *
 * @packageDocumentation
 *
 * @remarks
 * Everything this collector produces arrives keyed by carebook: the profile's
 * `identifiers.uid` becomes the `Patient`'s id and is what every medication's
 * `subject` references, and each medication carries carebook's own record id.
 * Those ids are unique *within carebook* — they say nothing about the
 * `Patient/1` some other collector may have written into the same on-device
 * store, and carebook is under no obligation to keep them inside FHIR's
 * `[A-Za-z0-9-.]{1,64}`.
 *
 * `fhir-r4`'s `identity` module resolves both. What is left here is the one
 * fact only this package can state: **whose** ids these are.
 */

/**
 * Rexall Be Well as the assigner of every id this collector re-keys.
 *
 * @remarks
 * `letsbewell.ca` is the site the user signs into and the identity the data
 * belongs to — not a URL this collector ever fetches (it only sniffs the
 * `rexall-prd-tunnel.letsbewell.ca` XHRs the SPA fires, and no tunnel URL is
 * ever opened directly). The tunnel host would be the wrong thing to name here
 * anyway: it encodes a deployment (`-prd-`) that could be renamed without the
 * user's prescriptions becoming different prescriptions, and the derived ids
 * must not move when it is.
 *
 * A module-level constant, so both entities re-key against one namespace
 * without either having to be built per configured account — which is what
 * keeps `ProfileEntity`'s `Patient` and `MedicationListEntity`'s `subject`
 * references pointing at each other. Two accounts on one device therefore share
 * a namespace and, for a shared record, a derived id; that is an upsert of the
 * same prescription rather than a collision between different ones.
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
 * @returns The same resources, each carrying a derived id, an `Identifier`
 *   naming carebook's own id, and rewritten references
 *
 * @remarks
 * The one line each entity's `parse` ends with — {@link RexallSource} applied,
 * and nothing else. Unlike `fhir-r4-client-collector`, there is no server to
 * read off the response: this collector points at one site by construction.
 */
const withSourceIdentity = <TResource extends SourceKeyedResource>(
  ast: SchemaAST.AST,
  resources: readonly TResource[]
): Effect.Effect<readonly TResource[], ParseResult.ParseError> =>
  parseWithSourceIdentity(RexallSource, ast, resources)

export { RexallSource, withSourceIdentity }
