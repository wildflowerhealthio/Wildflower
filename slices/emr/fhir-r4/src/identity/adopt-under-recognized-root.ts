import { Effect, Option, ParseResult, Schema } from 'effect'

import type { FhirResource } from '../resources/fhir-resource.ts'
import { adoptResource, type SourceIdentity } from './adopt-resource.ts'

/**
 * The structural shape of the HTTP request method as `http-extraction`'s
 * `HttpMethod` union — restated here rather than imported, same layering
 * reason as {@link AdoptableEntity} itself (this package sits below
 * `http-extraction`).
 */
type AdoptableMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'

/** The parse signature an adopted entity's wrapper stands in for. */
type AdoptableParse = (response: {
  readonly url: string
  readonly method: Option.Option<AdoptableMethod>
}) => Effect.Effect<readonly FhirResource[], ParseResult.ParseError>

/**
 * The structural shape of a response kind whose parse output can be adopted
 * under the identity its own `tryRecognize` mints.
 *
 * @remarks
 * Restates `HttpResponseKind` structurally rather than importing it — this
 * package sits below the `http-extraction` slice (the `CapturedResponse`
 * precedent); `fhir-r4-source` pins the two shapes against each other. `parse`
 * uses method syntax so its parameter checks bivariantly, letting a kind typed
 * against a concrete response satisfy the `{ url, method }` it reads.
 */
interface AdoptableEntity {
  readonly name: string
  readonly tryRecognize: (
    url: string,
    method: Option.Option<AdoptableMethod>
  ) => Option.Option<{
    readonly specificity: number
    readonly source?: SourceIdentity
  }>
  parse(response: {
    readonly url: string
    readonly method: Option.Option<AdoptableMethod>
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
 * A conditional rather than a constraint — a narrower kind is a legitimate
 * subtype (return types are covariant), so a constraint cannot reject one; the
 * intersection form keeps `TEntity` inferable off the naked half. The fix for a
 * kind that trips it is widen-first (see
 * `slices/collector/docs/Source Identity Explanation.md`).
 */
type EntityParsesEveryResource<TEntity extends AdoptableEntity> =
  FhirResource extends ParsedBy<TEntity>
    ? unknown
    : {
        readonly __adoptUnderRecognizedRoot: 'this response kind must parse the whole FhirResource union'
      }

// No wire schema produced this failure, so a String AST carries the URL as the
// offending value (the digestFailureAsParseError precedent).
const unrecognizedAst = Schema.String.ast

/**
 * Re-raise "this kind does not adopt an identity for this URL" as a
 * `ParseError` — the same channel a decode failure uses, so `Extraction.parseWith`
 * folds it to an ordinary per-response `parseError` outcome, never a widened
 * channel or a defect.
 */
const notAdoptableError = (name: string, url: string, reason: string): ParseResult.ParseError =>
  new ParseResult.ParseError({
    issue: new ParseResult.Forbidden(unrecognizedAst, url, `${name}: ${reason}`),
  })

/**
 * Adopt every resource a response kind parses under the identity **its own
 * `tryRecognize` mints for the response's URL** — the one per-kind adoption
 * seam. A source `.map`s its kind list through this once at module load.
 *
 * @param entity - The kind to wrap; its declared output must be the whole
 *   `FhirResource` union ({@link EntityParsesEveryResource})
 * @returns The same kind with its `parse` adopting, every other field kept by
 *   reference
 *
 * @remarks
 * Design, rationale, and the live-keying consequences are in
 * `slices/collector/docs/Source Identity Explanation.md`. The contract here:
 * only `parse` is wrapped, and only with `Effect.map` over a successful decode,
 * so the error channel and synchronous runnability are untouched. A `parse` on
 * a URL the kind does not recognize — or recognizes without minting a `source`
 * — fails with {@link notAdoptableError}; routing never hands a kind such a
 * response, so that arm guards a misuse, not a normal input. Do **not** route a
 * locally-minted resource through this (web-trace's traces already carry the
 * derived id — adopting would hash a hash).
 */
const adoptUnderRecognizedRoot = <TEntity extends AdoptableEntity>(
  entity: TEntity & EntityParsesEveryResource<TEntity>
): TEntity => {
  const parse: AdoptableParse = (response) =>
    Option.match(entity.tryRecognize(response.url, response.method), {
      onNone: () =>
        Effect.fail(
          notAdoptableError(
            entity.name,
            response.url,
            'URL not recognized by this kind — cannot adopt an identity'
          )
        ),
      onSome: ({ source }) =>
        Effect.gen(function* () {
          if (source == null)
            return yield* Effect.fail(
              notAdoptableError(
                entity.name,
                response.url,
                'recognized but mints no source identity — cannot adopt'
              )
            )
          const resources = yield* entity.parse(response)
          return resources.map(adoptResource(source))
        }),
    })
  const wrapped: TEntity = { ...entity, parse }
  Object.freeze(wrapped)
  return wrapped
}

export { adoptUnderRecognizedRoot, type AdoptableEntity }
