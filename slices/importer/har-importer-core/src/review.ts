import { Array as Arr, Effect, Option, type ParseResult } from 'effect'

import { Extraction, type HttpResponseKind } from 'http-extraction-fundamentals'

import * as HarSelection from './har-selection.ts'

/**
 * The HAR-specific preview pipeline: given decoded responses and a routing
 * selection, recognize each response against the kind pool and parse the
 * chosen ones into previewed resources. The per-response routing model
 * ({@link HarSelection}) lives in `./har-selection.ts`; the per-resource
 * selection (exclude/edit) lives in `importer-fundamentals`' `Review`
 * namespace.
 *
 * @packageDocumentation
 */

/**
 * The stable key one previewed resource is tracked by: the response id plus its
 * index in the parse output.
 */
const resourceKey = (responseId: string, index: number): string => `${responseId}:${index}`

/** Re-exported so the HAR React package reads recognition through here. */
const recognize = Extraction.recognize

/** One previewed resource: the parsed value plus its stable key. */
interface PreviewedResource<TParsed> {
  readonly key: string
  readonly resource: TParsed
}

/**
 * One response's preview outcome — every non-resource outcome folded to data so
 * `preview` is total and one bad response cannot abort the batch.
 */
type PreviewedOutcome<TParsed> =
  | { readonly _tag: 'resources'; readonly resources: readonly PreviewedResource<TParsed>[] }
  | { readonly _tag: 'parseError'; readonly error: ParseResult.ParseError }
  | { readonly _tag: 'bodyAbsent' }
  | { readonly _tag: 'noPick' }
  | { readonly _tag: 'duplicate'; readonly of: Extraction.ResponseRef }

/** One response's preview: recognition, resolved pick, and parse outcome. */
interface PreviewedResponse<K, TParsed> {
  readonly ref: Extraction.ResponseRef
  readonly recognized: Extraction.RecognizedResponse<K>
  readonly pickKindName: Option.Option<string>
  readonly outcome: PreviewedOutcome<TParsed>
}

const DUPLICATE_PICK: Option.Option<string> = Option.none()

/**
 * Parse every response the selection chose through its chosen kind, producing
 * one {@link PreviewedResponse} per input response, in input order.
 */
const preview = <TParsed>(
  pool: readonly HttpResponseKind.HttpResponseKind<TParsed>[],
  responses: readonly Extraction.Input[],
  selection: HarSelection.Selection
): Effect.Effect<
  readonly PreviewedResponse<HttpResponseKind.HttpResponseKind<TParsed>, TParsed>[]
> => {
  const duplicates = Extraction.findDuplicates(responses)
  return Effect.forEach(
    Arr.zip(responses, recognize(pool, responses)),
    ([response, recognized]) => {
      const duplicateOf = duplicates.get(response.id)
      if (duplicateOf !== undefined) {
        return Effect.succeed<
          PreviewedResponse<HttpResponseKind.HttpResponseKind<TParsed>, TParsed>
        >({
          ref: recognized.ref,
          recognized,
          pickKindName: DUPLICATE_PICK,
          outcome: { _tag: 'duplicate', of: duplicateOf },
        })
      }
      const pick = HarSelection.pickFor(recognized, selection)
      if (Option.isNone(pick)) {
        return Effect.succeed<
          PreviewedResponse<HttpResponseKind.HttpResponseKind<TParsed>, TParsed>
        >({
          ref: recognized.ref,
          recognized,
          pickKindName: Option.none(),
          outcome: { _tag: 'noPick' },
        })
      }
      const candidate = pick.value
      return Extraction.parseWith(candidate.kind, response).pipe(
        Effect.map(
          (outcome): PreviewedResponse<HttpResponseKind.HttpResponseKind<TParsed>, TParsed> => {
            const pickKindName = Option.some(candidate.kind.name)
            if (outcome._tag === 'resources') {
              return {
                ref: recognized.ref,
                recognized,
                pickKindName,
                outcome: {
                  _tag: 'resources',
                  resources: outcome.resources.map(
                    (resource, index): PreviewedResource<TParsed> => ({
                      key: resourceKey(recognized.ref.id, index),
                      resource,
                    })
                  ),
                },
              }
            }
            if (outcome._tag === 'parseError') {
              return {
                ref: recognized.ref,
                recognized,
                pickKindName,
                outcome: { _tag: 'parseError', error: outcome.error },
              }
            }
            return {
              ref: recognized.ref,
              recognized,
              pickKindName,
              outcome: { _tag: 'bodyAbsent' },
            }
          }
        )
      )
    }
  )
}

export { preview, recognize, resourceKey }
export type { PreviewedOutcome, PreviewedResource, PreviewedResponse }
