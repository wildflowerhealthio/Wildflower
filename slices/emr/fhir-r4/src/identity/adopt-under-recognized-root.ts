import { Effect, Option, ParseResult, Schema } from 'effect'

import type { FhirResource } from '../resources/fhir-resource.ts'
import { adoptResource, type SourceIdentity } from './adopt-resource.ts'

/** The parse signature an adopted entity's wrapper stands in for. */
type AdoptableParse = (response: {
  readonly url: string
}) => Effect.Effect<readonly FhirResource[], ParseResult.ParseError>

/**
 * The structural shape of a response kind whose parse output can be adopted
 * under the identity its own `tryRecognize` mints.
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

/** The resource type an entity's `parse` declares it produces. */
type ParsedBy<TEntity extends AdoptableEntity> =
  Effect.Effect.Success<ReturnType<TEntity['parse']>> extends readonly (infer TResource)[]
    ? TResource
    : never

/**
 * The precondition that makes {@link adoptUnderRecognizedRoot}'s passthrough
 * truthful: `unknown` when the kind declares the whole `FhirResource` union, a
 * shape nothing is assignable to when it declares less.
 *
 * @remarks
 * A conditional rather than a constraint because a narrower kind is a
 * *legitimate* subtype of {@link AdoptableEntity} — return types are covariant —
 * so a constraint cannot reject one. Written as an intersection so inference
 * still reads `TEntity` off the naked half.
 *
 * `adoptUnderRecognizedRoot` wraps one kind, so the guard reads `ParsedBy` off
 * the entity directly. Adoption widens to `FhirResource` and cannot be declared
 * not to, so a kind whose declared output is narrower is refused rather than
 * silently misdeclared. The fix is to widen the kind's declared resource type to
 * `HttpResponseKind<FhirResource>` before mapping (`fhirR4ResponseKinds` is
 * already that wide; the credential collectors widen their kind list to
 * `HttpResponseKind<FhirResource>[]` at module scope before the `.map`). Why the
 * combinator refuses rather than asserts is in
 * `slices/collector/docs/Source Identity Explanation.md`.
 */
type EntityParsesEveryResource<TEntity extends AdoptableEntity> =
  FhirResource extends ParsedBy<TEntity>
    ? unknown
    : {
        readonly __adoptUnderRecognizedRoot: 'this response kind must parse the whole FhirResource union'
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
 * per-kind combinator that replaced both the live constant-root wrapper and the
 * archive's per-URL-root wrapper.
 *
 * @param entity - The kind to wrap; its declared output must be the whole
 *   `FhirResource` union ({@link EntityParsesEveryResource})
 * @returns The same kind with its `parse` adopting, every other field kept by
 *   reference
 *
 * @remarks
 * The whole of a source's identity wiring: a package `.map`s its kind list
 * through this once at module load. The identity is read verbatim from
 * `entity.tryRecognize(response.url).source` — no source parameter, so there is
 * nothing to parameterize and two plans built from one config share the same
 * frozen kind by identity (no memo, and deep-equal gets *easier*). Only `parse`
 * is wrapped, and only with `Effect.map` over a successful decode, so the error
 * channel and synchronous runnability are untouched. See
 * `slices/collector/docs/Source Identity Explanation.md`.
 *
 * A `parse` on a response this kind's `tryRecognize` returns `None` for — **or**
 * `Some` with no `source` (a kind that recognizes but mints no identity has no
 * business being adopted) — **fails** with a {@link notAdoptableError} naming
 * the real reason, rather than passing through un-adopted (the old silent
 * archive behaviour) or dying. In practice the URL a kind is handed always
 * recognizes (routing put it there), so this arm guards a misconfiguration, not
 * a normal response.
 *
 * The result is declared as the plain {@link AdoptableEntity} the wrapper
 * actually is (generic in `TEntity` only to carry the guard and the caller's
 * element type through), so nothing here has to claim that a wrapper returning
 * `readonly FhirResource[]` satisfies some narrower declared `parse` — the
 * {@link EntityParsesEveryResource} guard is what makes that assignment sound.
 *
 * A locally-minted resource must **not** be routed through this. `web-trace`'s
 * traces derive their ids at their own codec, which is already the same
 * derivation — adopting them on top would hash a hash.
 *
 * The returned kind is shallow-frozen.
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

export { adoptUnderRecognizedRoot, type AdoptableEntity }
