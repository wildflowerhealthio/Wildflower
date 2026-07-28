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
 * A collector reads resources out of a remote it does not control, and writes
 * them into the one on-device store every collector shares. The source's own
 * logical id cannot be reused as-is for two independent reasons:
 *
 * - **It collides.** Two sites both number their first prescription `1`, and
 *   the store is keyed by `(resourceType, id)` alone — nothing else in the PUT
 *   distinguishes them, so the second write silently replaces the first.
 * - **It is often not a FHIR id.** FHIR bounds a logical id to 1–64 characters
 *   of `[A-Za-z0-9-.]`; a source id may be a uuid with underscores, a base64
 *   blob, or a 200-character opaque token.
 *
 * Both are solved by *deriving* the store's id rather than adopting the
 * source's: {@link deriveResourceId} hashes the source system, the resource
 * type, and the source id together, so the result is legal by construction,
 * collision-free across sites, and — the part that matters for a collector —
 * **stable across runs**, which is what makes the write an idempotent upsert
 * rather than a duplicate on every sync.
 *
 * Derivation is one-way, so the source id is written back onto the resource as
 * an `Identifier` (see `adoptSourceIdentity`) instead of being discarded.
 */

/**
 * Who assigned the ids a collector is re-keying: the namespace they were unique
 * within, and the label the derived ids carry.
 *
 * @remarks
 * `system` is the whole of the collision story — two sources are kept apart
 * because, and only because, they state different systems. It is a `URL`
 * rather than a string so it is normalized once at construction (case, default
 * port, empty-path `/`), which keeps a derived id from depending on how the
 * caller happened to spell the site; it is also written verbatim into
 * `Identifier.system`, whose decoded type is a `URL`.
 *
 * `prefix` buys nothing the hash needs — it is there so a human reading a
 * resource id in the store, a log line, or a trace can tell at a glance which
 * collector minted it. Keep it to `[A-Za-z0-9-.]`, since it is concatenated
 * into a FHIR logical id (see {@link deriveResourceId}).
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
 * not *the* id, and writing a resource under a fabricated one would upsert over
 * an unrelated record on the next run. In practice this means an insecure
 * origin (browsers gate `crypto.subtle` on secure contexts) or a runtime below
 * the project's floor — an environment defect rather than a per-resource
 * problem, which is why it names the reason rather than the resource.
 *
 * Structurally the same failure as `web-trace-core`'s `BodyDigestUnavailable`,
 * and deliberately not imported from it: `fhir-r4` sits below that package.
 */
class DerivedIdUnavailable extends Data.TaggedError('DerivedIdUnavailable')<{
  readonly reason: string
}> {}

/**
 * How much of the SHA-256 a derived id keeps.
 *
 * @remarks
 * 16 bytes → 32 hex characters, which with the longest prefix in use leaves the
 * id comfortably inside FHIR's 64-character bound. Truncation is safe here
 * because the property being relied on is collision resistance over a few
 * thousand ids per source, not preimage resistance: at 128 bits, a collision
 * remains overwhelmingly unlikely long past any plausible store size.
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
 * The three fields are joined by `|` — a character FHIR forbids in a logical id
 * and a URL cannot contain unescaped — so no two distinct triples can produce
 * the same input string by shifting a delimiter into a neighbouring field.
 * `resourceType` is in the hash even though the store already keys by it: it
 * keeps a source that reuses one id across two types (`Patient/7` and
 * `Observation/7`) from deriving one id twice, which would otherwise read as a
 * meaningful relationship between them.
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
 * WebView — the same line `web-trace-core` holds for body digests and HMACs.
 * Its digest is `Promise`-returning, which is why this is `Effect`-shaped and
 * every caller downstream of it is too.
 *
 * The result satisfies {@link FHIR_ID_PATTERN} for any input, provided
 * `source.prefix` does — hex contributes nothing outside `[0-9a-f]`, and the
 * length is fixed at `prefix.length + 33`.
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
 * collector that re-keys does so inside a `parse`. Stated once here rather than
 * per collector, so the two spell the failure identically — the same reason
 * `web-trace-collector` keeps a single `digestFailureAsParseError`.
 *
 * Failing (rather than dropping the resource and carrying on) is deliberate:
 * the un-derived resource would be written under the source's own id, which is
 * the collision this module exists to prevent.
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
 * This is the half of re-keying that keeps it honest. Derivation is a hash and
 * therefore one-way, so without this the trip back to the original record —
 * "which prescription on the site is this?" — would be unanswerable from the
 * stored resource alone.
 *
 * `use: 'secondary'` rather than `'official'`: FHIR's `secondary` is "assigned
 * in secondary use — identifies the object in a relative context", which is
 * exactly this id's standing here. It is authoritative *on the source site* and
 * meaningless off it, while the identifier the store itself trusts is the
 * derived `Resource.id`.
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
 * the system is compared, not the value: after adoption the resource's *id* is
 * the derived one, so a second pass has no way to recover the value it would
 * be looking for.
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
