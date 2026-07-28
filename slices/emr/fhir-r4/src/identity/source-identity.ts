import { Data, Effect, Encoding, ParseResult, type SchemaAST } from 'effect'

import type { IdentifierType } from '../data-types/complex/identifier-and-reference.ts'

/**
 * Deriving a store-local logical id from the id a source site assigned, and
 * recording the source's id as an `Identifier` so the resource stays traceable
 * back to it.
 *
 * @packageDocumentation
 *
 * @remarks
 * A collector reads resources out of a remote it does not control and writes
 * them into the one on-device store every collector shares, where the source's
 * own logical id fails twice: it **collides** (two sites both number their
 * first prescription `1`, and the store is keyed by `(resourceType, id)`
 * alone, so the second write replaces the first), and it is often **not a FHIR
 * id** at all (FHIR allows 1–64 characters of `[A-Za-z0-9-.]`; a source id may
 * be a uuid with underscores or a 200-character opaque token).
 *
 * {@link deriveResourceId} hashes the source system, resource type, and source
 * id together, so the result is legal by construction, collision-free across
 * sites, and — the part that matters for a collector — **stable across runs**,
 * which is what makes the write an idempotent upsert rather than a duplicate on
 * every sync. Derivation is one-way, so the source id is kept as an
 * `Identifier` (see `adoptSourceIdentity`) rather than discarded.
 */

/**
 * Who assigned the ids a collector is re-keying: the namespace they were unique
 * within, and the label the derived ids carry.
 *
 * @remarks
 * `system` is the whole of the collision story — two sources are kept apart
 * because, and only because, they state different systems. A `URL` rather than
 * a string so it normalizes once (case, default port, empty-path `/`) and a
 * derived id cannot depend on how the caller spelled the site; it is also
 * written verbatim into `Identifier.system`, whose decoded type is a `URL`.
 *
 * `prefix` buys nothing the hash needs — it makes a resource id legible as
 * "the Rexall collector minted this". Keep it to `[A-Za-z0-9-.]`, since it is
 * concatenated into a FHIR logical id.
 */
interface SourceIdentity {
  readonly prefix: string
  readonly system: URL
}

/**
 * Raised when `globalThis.crypto.subtle` is missing or its digest refuses.
 *
 * @remarks
 * Not recoverable by deriving something weaker: an id that is not the hash is
 * not *the* id, and a fabricated one would upsert over an unrelated record on
 * the next run. In practice it means an insecure origin (browsers gate
 * `crypto.subtle` on secure contexts) — an environment defect rather than a
 * per-resource problem, which is why it names the reason rather than the
 * resource. Structurally `web-trace-core`'s `BodyDigestUnavailable`, not
 * imported from it: `fhir-r4` sits below that package.
 */
class DerivedIdUnavailable extends Data.TaggedError('DerivedIdUnavailable')<{
  readonly reason: string
}> {}

/**
 * How much of the SHA-256 a derived id keeps.
 *
 * @remarks
 * 16 bytes → 32 hex characters, leaving the id well inside FHIR's 64-character
 * bound. Truncation is safe because what is relied on is collision resistance
 * over a few thousand ids per source, not preimage resistance: at 128 bits a
 * collision stays overwhelmingly unlikely past any plausible store size.
 */
const ID_BYTES = 16

/** FHIR R4's logical-id rule: 1–64 characters of `[A-Za-z0-9-.]`. */
const FHIR_ID_PATTERN = /^[A-Za-z0-9\-.]{1,64}$/

/**
 * The exact bytes a derived id hashes.
 *
 * @param source - Who assigned `externalId`
 * @param resourceType - The FHIR type the id belongs to
 * @param externalId - The logical id as the source stated it
 * @returns The digest input
 *
 * @remarks
 * Joined by `|`, which FHIR forbids in a logical id and a URL cannot contain
 * unescaped, so no two distinct triples collapse to one input by shifting the
 * delimiter into a neighbouring field. `resourceType` is hashed even though the
 * store already keys by it, so a source reusing one id across two types
 * (`Patient/7`, `Observation/7`) does not derive one id twice — which would
 * read as a relationship between them.
 */
const digestInput = (source: SourceIdentity, resourceType: string, externalId: string): string =>
  `${source.system.href}|${resourceType}|${externalId}`

/**
 * Derive the store-local logical id for one source-assigned id.
 *
 * @param source - Who assigned `externalId`
 * @param resourceType - The FHIR type the id belongs to
 * @param externalId - The logical id as the source stated it
 * @returns `<prefix>-<32 hex>`, stable for the same three inputs forever
 *
 * @remarks
 * Web Crypto rather than `node:crypto`, because a collector runs inside a
 * WebView — the line `web-trace-core` holds for body digests and HMACs. Its
 * digest is `Promise`-returning, which is why this is `Effect`-shaped and every
 * caller downstream of it is too. The result satisfies {@link FHIR_ID_PATTERN}
 * for any input, provided `source.prefix` does.
 */
const deriveResourceId = (
  source: SourceIdentity,
  resourceType: string,
  externalId: string
): Effect.Effect<string, DerivedIdUnavailable> =>
  Effect.suspend(() =>
    globalThis.crypto?.subtle === undefined
      ? Effect.fail(
          new DerivedIdUnavailable({
            reason:
              'globalThis.crypto.subtle is unavailable (insecure context or unsupported runtime)',
          })
        )
      : Effect.tryPromise({
          try: async () =>
            `${source.prefix}-${Encoding.encodeHex(
              new Uint8Array(
                await globalThis.crypto.subtle.digest(
                  'SHA-256',
                  new TextEncoder().encode(digestInput(source, resourceType, externalId))
                )
              ).subarray(0, ID_BYTES)
            )}`,
          catch: (cause) =>
            new DerivedIdUnavailable({ reason: `SHA-256 digest failed: ${String(cause)}` }),
        })
  )

/**
 * Re-raise a derivation failure as a `ParseError`.
 *
 * @param ast - The schema being produced when derivation was attempted; it
 *   names the type in the formatted error
 * @param cause - The derivation failure
 * @returns The equivalent `ParseError`
 *
 * @remarks
 * `EntityDefinition.parse` may fail only with a `ParseError`, and every
 * collector that re-keys does so inside a `parse` — so this is stated once
 * here rather than per collector, as `web-trace-collector` does with
 * `digestFailureAsParseError`.
 */
const derivedIdFailureAsParseError = (
  ast: SchemaAST.AST,
  cause: DerivedIdUnavailable
): ParseResult.ParseError =>
  new ParseResult.ParseError({
    issue: new ParseResult.Forbidden(
      ast,
      cause,
      `Could not derive a store-local resource id: ${cause.reason}`
    ),
  })

/**
 * The `Identifier` that records a source-assigned id on the resource derived
 * from it.
 *
 * @param source - Who assigned `externalId`
 * @param externalId - The logical id as the source stated it
 * @returns A decoded `Identifier` naming the source system and its id
 *
 * @remarks
 * The half of re-keying that keeps it honest: derivation is one-way, so without
 * this, "which prescription on the site is this?" is unanswerable from the
 * stored resource. `use: 'secondary'` rather than `'official'` because FHIR's
 * `secondary` is "assigned in secondary use — identifies the object in a
 * relative context", which is this id's standing exactly: authoritative on the
 * source site, meaningless off it.
 */
const sourceIdentifier = (source: SourceIdentity, externalId: string): IdentifierType => ({
  id: null,
  extension: [],
  assigner: null,
  period: null,
  system: source.system,
  type: null,
  use: 'secondary',
  value: externalId,
})

/**
 * Whether a resource already carries an identifier from this source.
 *
 * @param identifiers - The resource's `identifier` array
 * @param source - The source being adopted
 * @returns `true` when one of them names `source.system`
 *
 * @remarks
 * The marker that makes adoption idempotent — see `adoptSourceIdentity`. Only
 * the system is compared: after adoption the resource's *id* is the derived
 * one, so a second pass cannot recover the value it would look for.
 */
const hasSourceIdentifier = (
  identifiers: readonly IdentifierType[],
  source: SourceIdentity
): boolean => identifiers.some((identifier) => identifier.system?.href === source.system.href)

export {
  deriveResourceId,
  derivedIdFailureAsParseError,
  DerivedIdUnavailable,
  digestInput,
  FHIR_ID_PATTERN,
  hasSourceIdentifier,
  ID_BYTES,
  sourceIdentifier,
  type SourceIdentity,
}
