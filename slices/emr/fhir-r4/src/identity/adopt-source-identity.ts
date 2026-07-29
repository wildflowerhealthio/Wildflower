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
 * The outer `Map` is bounded by the number of distinct source systems configured
 * in a process; the inner `WeakMap` holds nothing alive on its own.
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
 */
const adoptEntity = <TEntity extends AdoptableEntity>(
  source: SourceIdentity,
  entity: TEntity
): TEntity => {
  const cache = parseCacheFor(source)
  const cached = cache.get(entity)
  const parse =
    cached ??
    ((response: unknown) =>
      Effect.map(entity.parse(response), (resources) => resources.map(adoptResource(source))))
  if (cached === undefined) {
    cache.set(entity, parse)
  }
  // `Object.assign` rather than a spread so the result's type is
  // `TEntity & { parse }` — assignable to `TEntity` without an assertion.
  const wrapped = Object.assign({}, entity, { parse })
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
 * `stepSequence`, `firstPage`, timeouts) passes through by reference. Within an
 * entity only `parse` is wrapped, and only with `Effect.map`, so the error
 * channel is untouched and parses stay synchronously runnable.
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
  <TPlan extends { readonly entityDefinitions: readonly AdoptableEntity[] }>(
    plan: TPlan
  ): TPlan => {
    const entityDefinitions = plan.entityDefinitions.map((entity) => adoptEntity(source, entity))
    Object.freeze(entityDefinitions)
    const adopted = Object.assign({}, plan, { entityDefinitions })
    Object.freeze(adopted)
    return adopted
  }

export { adoptSourceIdentity, type AdoptableEntity }
