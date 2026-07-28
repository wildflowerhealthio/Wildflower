import type { Effect, ParseResult, SchemaAST } from 'effect'
import {
  type FhirUrlShape,
  parseWithFhirServerIdentity,
  type SourceKeyedResource,
} from 'fhir-r4/identity'

/**
 * This collector's claim about who assigned the ids it re-keys — its prefix,
 * and the URL shape each entity matched. Why resources are re-keyed at all, and
 * how a response URL yields the server that named them, is `fhir-r4`'s
 * `identity` module.
 *
 * @packageDocumentation
 */

/**
 * Names this collector in every id it derives.
 *
 * @remarks
 * Legible rather than load-bearing — the hash separates sources on its own.
 * Must stay within FHIR's `[A-Za-z0-9-.]` id characters, since it is
 * concatenated into a logical id.
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
 * @returns The same resources, re-keyed against the server that served them
 *
 * @remarks
 * The server is read off `response.url` rather than `config.rootUrl`: both name
 * the same server, but the response is what an entity already has, while config
 * would mean building entities per configured remote — turning three
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
