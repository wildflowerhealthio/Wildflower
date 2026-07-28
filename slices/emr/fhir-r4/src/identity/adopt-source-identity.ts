import { Effect, type ParseResult, type SchemaAST } from 'effect'

import type { IdentifierType } from '../data-types/complex/identifier-and-reference.ts'
import {
  type ReferenceRewrite,
  type RelativeReference,
  relativeReferencesIn,
  withRewrittenReferences,
} from './relative-reference.ts'
import {
  deriveResourceId,
  type DerivedIdUnavailable,
  derivedIdFailureAsParseError,
  hasSourceIdentifier,
  sourceIdentifier,
  type SourceIdentity,
} from './source-identity.ts'

/**
 * Re-keying a decoded resource onto store-local ids: its own, and every
 * relative reference it makes.
 *
 * @packageDocumentation
 */

/**
 * The minimum a resource must expose to be re-keyed: its FHIR type, the logical
 * id the source gave it, and the `identifier` list the source id is recorded
 * in.
 *
 * @remarks
 * Structural rather than the `FhirResource` union, so a collector whose entity
 * produces a narrower type (a `MedicationRequest | MedicationDispense`, say)
 * keeps that type through re-keying instead of being widened — the same reason
 * `web-trace-core`'s provenance capture states a `ReferencableResource`.
 *
 * `Binary` is the one member of the union this excludes, since it has no
 * `identifier` element to record a source id in. That is a property of the
 * resource, not an oversight: a `Binary` is a blob addressed by whatever names
 * it, and nothing in this repo's collectors produces one.
 */
interface SourceKeyedResource {
  readonly resourceType: string
  readonly id: string | null
  readonly identifier: readonly IdentifierType[]
}

/** `Type/id`, the key a derived-id lookup is built on. */
const referenceKey = (reference: RelativeReference): string =>
  `${reference.resourceType}/${reference.id}`

/**
 * Derive the store-local id of every relative reference in a resource, once
 * each.
 *
 * @param source - Who assigned the ids being re-keyed
 * @param resource - The decoded resource
 * @returns A lookup from the source's `Type/id` to the derived `Type/id`
 *
 * @remarks
 * Deduplicated before deriving, so a resource naming one subject in three
 * fields costs one digest rather than three, and every occurrence is guaranteed
 * to be rewritten to the same value — the walk consults a lookup rather than
 * re-deriving per site.
 */
const derivedReferences = (
  source: SourceIdentity,
  resource: SourceKeyedResource
): Effect.Effect<ReadonlyMap<string, string>, DerivedIdUnavailable> =>
  Effect.gen(function* () {
    const unique = new Map<string, RelativeReference>()
    for (const reference of relativeReferencesIn(resource))
      unique.set(referenceKey(reference), reference)
    const derived = new Map<string, string>()
    for (const [key, reference] of unique) {
      const id = yield* deriveResourceId(source, reference.resourceType, reference.id)
      derived.set(key, `${reference.resourceType}/${id}`)
    }
    return derived
  })

/**
 * Re-key one decoded resource onto the store's namespace.
 *
 * @param source - Who assigned the ids it arrived with
 * @param resource - The decoded resource, exactly as its entity produced it
 * @returns The same resource, re-keyed and traceable
 *
 * @remarks
 * Three changes, which are one change — a resource is only safe to store once
 * all three have happened together:
 *
 * 1. **`id`** becomes `deriveResourceId(source, resourceType, id)`, so two sites
 *    that both call a prescription `1` no longer overwrite each other, and the
 *    same record re-collected next week upserts itself rather than duplicating.
 * 2. **`identifier`** gains `{ system: source.system, value: <the source's id> }`,
 *    because the derivation is one-way and the trip back to the original record
 *    has to stay possible.
 * 3. **Every relative reference** is put through the same derivation, so
 *    `subject: 'Patient/uid-abc'` still names the very `Patient` this collector
 *    stored — see `relative-reference.ts`.
 *
 * A resource with a `null` id is left **entirely** untouched, references
 * included. There is nothing to derive from, `upsertResource` already skips it,
 * and re-keying its references while it is itself unstorable would produce
 * links into a namespace this resource is not part of.
 *
 * **Idempotent.** A resource that already carries an identifier from this
 * source is returned as it stands, so a second pass cannot hash an
 * already-derived id into a third one. This is a real hazard rather than a
 * hypothetical: `parse` is where re-keying happens, and a resource can reach a
 * sink from more than one path.
 */
const adoptSourceIdentity = <TResource extends SourceKeyedResource>(
  source: SourceIdentity,
  resource: TResource
): Effect.Effect<TResource, DerivedIdUnavailable> =>
  Effect.gen(function* () {
    const externalId = resource.id
    if (externalId === null) return resource
    if (hasSourceIdentifier(resource.identifier, source)) return resource

    const derived = yield* derivedReferences(source, resource)
    const identifier = sourceIdentifier(source, externalId)
    const rewrite: ReferenceRewrite = (reference) => {
      const rewritten = derived.get(referenceKey(reference))
      return rewritten === undefined
        ? null
        : { reference: rewritten, identifier: sourceIdentifier(source, reference.id) }
    }

    return {
      ...withRewrittenReferences(resource, rewrite),
      id: yield* deriveResourceId(source, resource.resourceType, externalId),
      identifier: [...resource.identifier, identifier],
    }
  })

/**
 * Re-key a whole parse output.
 *
 * @param source - Who assigned the ids they arrived with
 * @param resources - Everything one response produced
 * @returns The same resources, each re-keyed
 *
 * @remarks
 * The form an entity's `parse` actually uses, since a `parse` returns an array.
 * Each resource is re-keyed independently — two resources in one batch are
 * linked through their references, and those resolve because the derivation is
 * a pure function of the source id, not because the batch was processed
 * together.
 */
const adoptSourceIdentityAll = <TResource extends SourceKeyedResource>(
  source: SourceIdentity,
  resources: readonly TResource[]
): Effect.Effect<readonly TResource[], DerivedIdUnavailable> =>
  Effect.forEach(resources, (resource) => adoptSourceIdentity(source, resource))

/**
 * Re-key a parse output, with the failure already shaped as a `ParseError`.
 *
 * @param source - Who assigned the ids the resources arrived with
 * @param ast - The schema the caller was decoding, for the failure message
 * @param resources - The decoded resources
 * @returns The same resources, re-keyed
 *
 * @remarks
 * The form a collector's `EntityDefinition.parse` uses — the one line an entity
 * ends with. It exists here rather than as a wrapper in each collector because
 * every re-keying collector needs exactly this and nothing more: `parse` may
 * fail only with a `ParseError`, so each would otherwise restate the same
 * `mapError`, and two collectors spelling the same environment failure
 * differently is how a shared diagnosis stops being searchable.
 *
 * Failing rather than dropping the resource is the deliberate half: the
 * un-derived resource would be written under the source's own id, which is the
 * collision the derivation exists to prevent. The failure means Web Crypto was
 * unavailable — an environment defect, not a problem with this response — so it
 * fails the one parse and leaves the rest of the run draining.
 */
const parseWithSourceIdentity = <TResource extends SourceKeyedResource>(
  source: SourceIdentity,
  ast: SchemaAST.AST,
  resources: readonly TResource[]
): Effect.Effect<readonly TResource[], ParseResult.ParseError> =>
  Effect.mapError(adoptSourceIdentityAll(source, resources), (cause) =>
    derivedIdFailureAsParseError(ast, cause)
  )

export {
  adoptSourceIdentity,
  adoptSourceIdentityAll,
  parseWithSourceIdentity,
  type SourceKeyedResource,
}
