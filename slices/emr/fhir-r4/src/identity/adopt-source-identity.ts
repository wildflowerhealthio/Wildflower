import { Effect, type ParseResult } from 'effect'

import type { FhirResource } from '../resources/fhir-resource.ts'
import { adoptResource, type SourceIdentity } from './adopt-resource.ts'

/** The parse signature an adopted entity's wrapper stands in for. */
type AdoptableParse = (
  response: unknown
) => Effect.Effect<readonly FhirResource[], ParseResult.ParseError>

/**
 * The structural shape of an entity definition whose parse output can be
 * adopted.
 *
 * @remarks
 * Structural rather than `collector-fundamentals`' `EntityDefinition`: this
 * package sits below the collector slice and cannot import it — the same
 * precedent `web-trace-core`'s `CapturedResponse` sets.
 *
 * `parse` is declared with method syntax so its parameter is checked
 * bivariantly, which is what lets a concrete entity typed against the
 * collector's own `RemoteResponse` satisfy an `unknown` here. The trick is
 * `collector-fundamentals`' own, used on `EntityDefinition.followUpSteps` for
 * the same reason.
 */
interface AdoptableEntity {
  readonly name: string
  readonly isFoundAt: (url: string) => boolean
  parse(response: unknown): Effect.Effect<readonly FhirResource[], ParseResult.ParseError>
}

/** The one field of a scraping plan {@link adoptSourceIdentity} rewrites. */
interface AdoptablePlan {
  readonly entityDefinitions: readonly AdoptableEntity[]
}

/** The resource type an entity's `parse` declares it produces. */
type ParsedBy<TEntity extends AdoptableEntity> =
  Effect.Effect.Success<ReturnType<TEntity['parse']>> extends readonly (infer TResource)[]
    ? TResource
    : never

/**
 * The precondition that makes {@link adoptSourceIdentity}'s passthrough
 * truthful: `unknown` when the plan's entities declare the whole `FhirResource`
 * union, and a shape nothing is assignable to when they declare less.
 *
 * @remarks
 * A conditional rather than a constraint because a narrower entity is a
 * *legitimate* subtype of {@link AdoptableEntity} — return types are covariant —
 * so a constraint cannot reject one. Written as an intersection so inference
 * still reads `TPlan` off the naked half.
 *
 * The fix for a plan that trips this is to widen its own entity list, as both
 * production collectors do at `ScrapingPlan.make<FhirResource>`. Why the
 * combinator refuses rather than asserts is in
 * `slices/collector/docs/Source Identity Explanation.md`.
 */
type EntitiesParseEveryResource<TPlan extends AdoptablePlan> =
  FhirResource extends ParsedBy<TPlan['entityDefinitions'][number]>
    ? unknown
    : {
        readonly __adoptSourceIdentity: 'the entities of this plan must parse the whole FhirResource union'
      }

/**
 * The wrapped `parse` closures, keyed by source and then by the entity they
 * wrap.
 *
 * @remarks
 * Load-bearing for referential stability. Per-collector suites deep-equal two
 * plans built from one config, and `toEqual` compares functions by identity — a
 * combinator that minted a fresh closure per call would fail every one of them.
 * Entities are frozen module singletons, so for a fixed source each wrapper is
 * minted once per process and both plans name the same function.
 *
 * The inner `WeakMap` holds nothing alive on its own — the wrapper closing over
 * its own key is fine under ephemeron semantics, so an entry drops with its
 * entity.
 *
 * **The outer `Map` is never evicted, and its key space is user-driven rather
 * than structural** — for `fhir-r4-client-collector` the key carries the user's
 * configured `rootUrl`, so every distinct value typed adds a permanent entry of
 * one empty `WeakMap`. Accepted rather than solved: a string key cannot be held
 * weakly, and evicting would trade this for the referential stability the memo
 * exists to provide.
 */
const wrappedParses = new Map<string, WeakMap<AdoptableEntity, AdoptableParse>>()

/** The memo key for a source: its system and its optional base URL. */
const sourceKey = (source: SourceIdentity): string => `${source.system}\n${source.baseUrl ?? ''}`

const parseCacheFor = (source: SourceIdentity): WeakMap<AdoptableEntity, AdoptableParse> => {
  const key = sourceKey(source)
  const existing = wrappedParses.get(key)
  if (existing !== undefined) {
    return existing
  }
  const created = new WeakMap<AdoptableEntity, AdoptableParse>()
  wrappedParses.set(key, created)
  return created
}

/**
 * The entity with its `parse` output adopted; every other field keeps its
 * original reference.
 *
 * @remarks
 * Deliberately not generic in the entity. The result is declared as the plain
 * {@link AdoptableEntity} it actually is, so nothing here has to claim that a
 * wrapper returning `readonly FhirResource[]` satisfies some narrower declared
 * `parse`. The plan-level {@link EntitiesParseEveryResource} guard is what makes
 * assigning this back into the caller's own entity slot sound.
 */
const adoptEntity = (source: SourceIdentity, entity: AdoptableEntity): AdoptableEntity => {
  const cache = parseCacheFor(source)
  const cached = cache.get(entity)
  const parse =
    cached ??
    ((response: unknown) =>
      Effect.map(entity.parse(response), (resources) => resources.map(adoptResource(source))))
  if (cached === undefined) {
    cache.set(entity, parse)
  }
  const wrapped = { ...entity, parse }
  Object.freeze(wrapped)
  return wrapped
}

/**
 * Adopt every resource a scraping plan's entities parse into one source's
 * namespace.
 *
 * @param source - The system this collector imports from
 * @returns A function from a plan to the same plan with adopting entities
 *
 * @remarks
 * The whole of a collector's wiring: end the plan factory with
 * `adoptSourceIdentity(SOURCE)(ScrapingPlan.make({ … }))`. Entities stay unaware
 * — their suites keep testing the un-adopted decode. See
 * `slices/collector/docs/Source Identity Explanation.md`.
 *
 * Only `entityDefinitions` changes; every other plan field (`captureProvenance`,
 * `stepSequence`, timeouts) passes through by reference. Within an
 * entity only `parse` is wrapped, and only with `Effect.map`, so the error
 * channel is untouched and parses stay synchronously runnable.
 *
 * The plan's own type passes through unchanged, which is only honest for a plan
 * whose entities already declare the full `FhirResource` union — adoption
 * widens, and cannot be declared not to. {@link EntitiesParseEveryResource}
 * turns that from a convention into a compile error at this call site.
 *
 * A locally-minted resource must **not** be routed through this. `web-trace`'s
 * traces derive their ids at their own codec, which is already the same
 * derivation — adopting them on top would hash a hash.
 *
 * The returned plan and each wrapped entity are shallow-frozen. Deliberately not
 * deep-frozen: a plan carries process-wide-singleton `Duration`s, and its
 * children are already frozen by the plan's own constructor.
 */
const adoptSourceIdentity =
  (source: SourceIdentity) =>
  <TPlan extends AdoptablePlan>(plan: TPlan & EntitiesParseEveryResource<TPlan>): TPlan => {
    const entityDefinitions = plan.entityDefinitions.map((entity) => adoptEntity(source, entity))
    Object.freeze(entityDefinitions)
    const adopted = { ...plan, entityDefinitions }
    Object.freeze(adopted)
    return adopted
  }

export { adoptSourceIdentity, type AdoptableEntity, type AdoptablePlan }
