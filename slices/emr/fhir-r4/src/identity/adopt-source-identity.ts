import { Effect, Option, ParseResult, Schema } from 'effect'

import type { FhirResource } from '../resources/fhir-resource.ts'
import { adoptResource, type SourceIdentity } from './adopt-resource.ts'

/** The parse signature an adopted entity's wrapper stands in for. */
type AdoptableParse = (response: {
  readonly url: string
}) => Effect.Effect<readonly FhirResource[], ParseResult.ParseError>

/**
 * The structural shape of an entity definition whose parse output can be
 * adopted.
 *
 * @remarks
 * Structural rather than `http-extraction-fundamentals`' `HttpResponseKind`: this
 * package sits below the collector slice and cannot import it — the same
 * precedent `web-trace-core`'s `CapturedResponse` sets.
 *
 * `tryRecognize` mirrors `HttpResponseKind.tryRecognize` structurally: `Some`
 * carries how specific the claim is and, when the kind mints one, the
 * {@link SourceIdentity} its resources key under; `None` (or a `Some` with no
 * `source`) is a URL this kind does not adopt an identity for.
 * {@link adoptUnderRecognizedRoot} reads the `source` off it verbatim.
 *
 * `parse` is declared with method syntax so its parameter is checked
 * bivariantly, which is what lets a concrete entity typed against the
 * collector's own `CollectorHttpResponse` satisfy the narrowed
 * `{ url: string }` here. The trick is `collector-fundamentals`' own, used on
 * `CollectorHttpResponseKind.followUpSteps` for the same reason. The parameter
 * is narrowed from the old `unknown` to the one field the combinator reads.
 */
interface AdoptableEntity {
  readonly name: string
  readonly tryRecognize: (url: string) => Option.Option<{
    readonly specificity: number
    readonly source?: SourceIdentity
  }>
  parse(response: {
    readonly url: string
  }): Effect.Effect<readonly FhirResource[], ParseResult.ParseError>
}

/** The one field of a scraping plan {@link adoptSourceIdentity} rewrites. */
interface AdoptablePlan {
  readonly responseKinds: readonly AdoptableEntity[]
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
  FhirResource extends ParsedBy<TPlan['responseKinds'][number]>
    ? unknown
    : {
        readonly __adoptSourceIdentity: 'the entities of this plan must parse the whole FhirResource union'
      }

/**
 * The per-kind sibling of {@link EntitiesParseEveryResource}, for
 * {@link adoptUnderRecognizedRoot}: `unknown` when the single entity declares
 * the whole `FhirResource` union, an unassignable shape when it declares less.
 *
 * @remarks
 * `adoptUnderRecognizedRoot` wraps one kind (not a plan), so the guard reads
 * `ParsedBy` off the entity directly. Same reasoning as the plan-level guard —
 * adoption widens to `FhirResource` and cannot be declared not to, so a kind
 * whose declared output is narrower is refused rather than silently
 * misdeclared. The fix is the same: widen the kind's declared resource type to
 * `HttpResponseKind<FhirResource>` before mapping (`fhirR4ResponseKinds` is
 * already that wide).
 */
type EntityParsesEveryResource<TEntity extends AdoptableEntity> =
  FhirResource extends ParsedBy<TEntity>
    ? unknown
    : {
        readonly __adoptUnderRecognizedRoot: 'this response kind must parse the whole FhirResource union'
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
    ((response: { readonly url: string }) =>
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
 * Only `responseKinds` changes; every other plan field (`captureProvenance`,
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
    const responseKinds = plan.responseKinds.map((entity) => adoptEntity(source, entity))
    Object.freeze(responseKinds)
    const adopted = { ...plan, responseKinds }
    Object.freeze(adopted)
    return adopted
  }

/**
 * A schema AST for the `ParseError` a non-recognized response fails with. The
 * failure is not a decode failure, so there is no wire schema that produced it;
 * a `String` AST just carries the URL as the offending value, the same way
 * `web-trace`'s `digestFailureAsParseError` re-raises a non-parse cause as a
 * `ParseError`.
 */
const unrecognizedAst = Schema.String.ast

/**
 * Re-raise "this kind does not adopt an identity for this URL" as the
 * `ParseError` an entity's `parse` may fail with.
 *
 * @param name - The entity that was asked to adopt
 * @param url - The response URL it did not recognize (or recognized without a
 *   source)
 * @param reason - The real reason, named for the reader
 * @returns The equivalent `ParseError`, on the same channel a decode failure
 *   uses — so `Extraction.run` reports it as an ordinary per-response
 *   `parseFailure`, never a widened channel or a defect
 */
const notAdoptableError = (name: string, url: string, reason: string): ParseResult.ParseError =>
  new ParseResult.ParseError({
    issue: new ParseResult.Forbidden(unrecognizedAst, url, `${name}: ${reason}`),
  })

/**
 * Adopt every resource a single response kind parses under the identity **its
 * own `tryRecognize` mints for the response's URL** — the one, option-less
 * per-kind combinator that replaces both the live `adoptSourceIdentity(const)`
 * wrapper and the archive's per-URL-root wrapper.
 *
 * @param entity - The kind to wrap; its declared output must be the whole
 *   `FhirResource` union ({@link EntityParsesEveryResource})
 * @returns The same kind with its `parse` adopting, every other field kept by
 *   reference
 *
 * @remarks
 * The identity is read verbatim from `entity.tryRecognize(response.url).source`
 * — no source parameter, so a package applies this once at module load and two
 * plans from one config share the same frozen kind by identity (no memo, and
 * deep-equal gets *easier*). Only `parse` is wrapped, and only with
 * `Effect.map` over a successful decode, so the error channel and synchronous
 * runnability are untouched.
 *
 * A `parse` on a response this kind's `tryRecognize` returns `None` for — **or**
 * `Some` with no `source` (a kind that recognizes but mints no identity has no
 * business being adopted) — **fails** with a {@link notAdoptableError} naming
 * the real reason, rather than passing through un-adopted (the old silent
 * archive behaviour) or dying. In practice the URL a kind is handed always
 * recognizes (routing put it there), so this arm guards a misconfiguration, not
 * a normal response.
 */
const adoptUnderRecognizedRoot = <TEntity extends AdoptableEntity>(
  entity: TEntity & EntityParsesEveryResource<TEntity>
): TEntity => {
  const parse: AdoptableParse = (response) =>
    Option.match(entity.tryRecognize(response.url), {
      onNone: () =>
        Effect.fail(
          notAdoptableError(
            entity.name,
            response.url,
            'URL not recognized by this kind — cannot adopt an identity'
          )
        ),
      onSome: (recognized) => {
        const source = recognized.source
        return source === undefined
          ? Effect.fail(
              notAdoptableError(
                entity.name,
                response.url,
                'recognized but mints no source identity — cannot adopt'
              )
            )
          : Effect.map(entity.parse(response), (resources) => {
              const adopt = adoptResource(source)
              return resources.map((resource) => adopt(resource))
            })
      },
    })
  const wrapped: TEntity = { ...entity, parse }
  Object.freeze(wrapped)
  return wrapped
}

export { adoptSourceIdentity, adoptUnderRecognizedRoot, type AdoptableEntity, type AdoptablePlan }
