import { Effect, Match, Option, type ParseResult } from 'effect'

import { Extraction, type HttpResponseKind } from '@wildflowerhealthio/http-extraction-fundamentals'

/**
 * The HAR-specific preview pipeline: given decoded responses, route each
 * response to its top-ranked kind in the pool (`Extraction.routeTo`) and parse
 * it through that kind into previewed records. The importer's decode folds these
 * previews into the sections and notes the shell reviews; the per-resource
 * selection (exclude/edit) lives in `importer-fundamentals`' `StagedImport`
 * namespace.
 *
 * @packageDocumentation
 */

/**
 * The key one previewed resource is tracked by: the response id plus its index
 * in the parse output, unique within one decode of the archive.
 */
const resourceKey = (responseId: string, index: number): string => `${responseId}:${index}`

/** One previewed record: the record plus its stable key. */
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

/** One response's preview: the response, the kind it routed to, and the parse outcome. */
interface PreviewedResponse<TParsed> {
  readonly ref: Extraction.ResponseRef
  readonly pickKindName: Option.Option<string>
  readonly outcome: PreviewedOutcome<TParsed>
}

/**
 * Parse every response through its top-specificity kind, producing one
 * {@link PreviewedResponse} per input response, in input order.
 *
 * @param pool - The kinds to route through
 * @param responses - The archive's responses
 */
const preview = <TParsed>(
  pool: readonly HttpResponseKind.HttpResponseKind<TParsed>[],
  responses: readonly Extraction.Input[]
): Effect.Effect<readonly PreviewedResponse<TParsed>[]> => {
  type Previewed = PreviewedResponse<TParsed>
  const duplicates = Extraction.findDuplicates(responses)
  return Effect.forEach(responses, (response) => {
    const ref: Extraction.ResponseRef = { id: response.id, url: response.url }
    const duplicateOf = duplicates.get(response.id)
    if (duplicateOf !== undefined) {
      return Effect.succeed<Previewed>({
        ref,
        pickKindName: Option.none(),
        outcome: { _tag: 'duplicate', of: duplicateOf },
      })
    }
    const pick = Extraction.routeTo(pool, response.url, response.method)
    if (Option.isNone(pick)) {
      return Effect.succeed<Previewed>({
        ref,
        pickKindName: Option.none(),
        outcome: { _tag: 'noPick' },
      })
    }
    const candidate = pick.value
    const pickKindName = Option.some(candidate.kind.name)
    return Extraction.parseWith(candidate.kind, response).pipe(
      Effect.map((outcome): Previewed => {
        const previewed = Match.value(outcome).pipe(
          Match.tag('resources', ({ resources }): PreviewedOutcome<TParsed> => ({
            _tag: 'resources',
            resources: resources.map((resource, index): PreviewedResource<TParsed> => ({
              key: resourceKey(ref.id, index),
              resource,
            })),
          })),
          Match.tag('parseError', ({ error }): PreviewedOutcome<TParsed> => ({
            _tag: 'parseError',
            error,
          })),
          Match.tag('bodyAbsent', (): PreviewedOutcome<TParsed> => ({ _tag: 'bodyAbsent' })),
          Match.exhaustive
        )
        return { ref, pickKindName, outcome: previewed }
      })
    )
  })
}

export { preview, resourceKey }
export type { PreviewedOutcome, PreviewedResource, PreviewedResponse }
