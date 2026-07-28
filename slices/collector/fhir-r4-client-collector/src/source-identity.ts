import type { Effect, ParseResult, SchemaAST } from 'effect'
import {
  type FhirUrlShape,
  parseWithFhirServerIdentity,
  type SourceKeyedResource,
} from 'fhir-r4/identity'

/**
 * This collector's claim about who assigned the ids it re-keys.
 *
 * @packageDocumentation
 *
 * @remarks
 * Resources arrive here carrying the ids the *remote* server assigned, and are
 * written into the one on-device store every collector shares — so two servers
 * that both host a `Patient/1` would otherwise overwrite each other. All of
 * that is `fhir-r4`'s `identity` module: it derives the store's ids, records
 * the server's as `Identifier`s, rewrites the references between them, and
 * recovers the service base URL that names the server from a response URL.
 *
 * What is left here is the one fact only this package can state — **which
 * collector** — plus the URL shape each entity matched. Anything more general
 * belongs upstream, where the next FHIR-server collector will find it instead
 * of copying it.
 */

/**
 * Names this collector in every id it derives.
 *
 * @remarks
 * Legible rather than load-bearing: the hash separates sources on its own, and
 * this is what makes `fhir-r4-3f9a…` readable as "the FHIR collector minted
 * this" in the store, a log line, or a trace. Must stay within FHIR's
 * `[A-Za-z0-9-.]` id characters, since it is concatenated into a logical id.
 */
const SOURCE_PREFIX = 'fhir-r4'

/**
 * Re-key everything one response produced onto the store's namespace.
 *
 * @param responseUrl - The response's URL, which names the server that assigned
 *   the ids being replaced
 * @param shape - Which read shape the calling entity recognized: `'instance'`
 *   for `…/Patient/<id>`, `'search'` for `…/Observation?…`
 * @param ast - The schema the entity was decoding, for the failure message
 * @param resources - The decoded resources, as the entity produced them
 * @returns The same resources, each carrying a derived id, an `Identifier`
 *   naming the server's own id, and rewritten references
 *
 * @remarks
 * The one line each entity's `parse` ends with. The shape is passed rather than
 * inferred from the path: `Patient/JohnDoe` is a legal instance URL whose id is
 * itself type-shaped, and guessing wrong puts one resource in a namespace of
 * its own — the entity already knows which pattern it matched.
 *
 * The server is read off `response.url` rather than `config.rootUrl`. Both name
 * the same server, but the response is what an entity already has; taking it
 * from config would mean building entities per configured remote, turning three
 * module-level constants into factories and taking the `ScrapingPlan`
 * deep-equality the config tests rest on with them.
 */
const withSourceIdentity = <TResource extends SourceKeyedResource>(
  responseUrl: string,
  shape: FhirUrlShape,
  ast: SchemaAST.AST,
  resources: readonly TResource[]
): Effect.Effect<readonly TResource[], ParseResult.ParseError> =>
  parseWithFhirServerIdentity(SOURCE_PREFIX, shape, responseUrl, ast, resources)

export { SOURCE_PREFIX, withSourceIdentity }
