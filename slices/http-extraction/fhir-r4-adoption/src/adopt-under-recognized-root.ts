import type { FhirResource, FhirResourceWithId } from '@wildflowerhealthio/fhir-r4/resources'
import { HttpResponseKind } from '@wildflowerhealthio/http-extraction-fundamentals'
import { Effect, Option, ParseResult, Schema } from 'effect'

import { adoptResource } from './adopt-resource.ts'

// No wire schema produced this failure, so a String AST carries the URL as the
// offending value.
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
 * @param kind - The kind to wrap
 * @returns The same kind with its `parse` adopting every resource, so
 *   yielding each with an id; its `name` and `tryRecognize` are `kind`'s own
 *
 * @remarks
 * Design and rationale are in this package's
 * `docs/Source Identity Explanation.md`. Only `parse` is wrapped, and only
 * with `Effect.map` over a successful decode, so the error channel and
 * synchronous runnability are untouched. A `parse` on a URL the kind does not
 * recognize — or recognizes without minting a `source` — fails with
 * {@link notAdoptableError}; routing never hands a kind such a response, so
 * that arm guards a misuse, not a normal input. Do **not** route a
 * locally-minted resource through this (web-trace's traces already carry the
 * derived id — adopting would hash a hash).
 */
const adoptUnderRecognizedRoot = (
  kind: HttpResponseKind.HttpResponseKind<FhirResource>
): HttpResponseKind.HttpResponseKind<FhirResourceWithId> =>
  HttpResponseKind.make({
    name: kind.name,
    tryRecognize: kind.tryRecognize,
    parse: (response) =>
      Option.match(kind.tryRecognize(response.url, response.method), {
        onNone: () =>
          Effect.fail(
            notAdoptableError(
              kind.name,
              response.url,
              'URL not recognized by this kind — cannot adopt an identity'
            )
          ),
        onSome: ({ source }) =>
          source === undefined
            ? Effect.fail(
                notAdoptableError(
                  kind.name,
                  response.url,
                  'recognized but mints no source identity — cannot adopt'
                )
              )
            : Effect.map(kind.parse(response), (resources) => resources.map(adoptResource(source))),
      }),
  })

export { adoptUnderRecognizedRoot }
