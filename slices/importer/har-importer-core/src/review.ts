import { Array as Arr, Effect, Option, type ParseResult } from 'effect'

import { Extraction, type HttpResponseKind } from 'http-extraction-fundamentals'

/**
 * The HAR-specific preview pipeline: given decoded responses and the enabled
 * kind names, recognize each response against the kind pool and parse the
 * chosen ones into previewed resources. The descriptor's decode folds these
 * previews into the sections and notes the shell reviews; the per-resource
 * selection (exclude/edit) lives in `importer-fundamentals`' `Review`
 * namespace.
 *
 * @packageDocumentation
 */

/**
 * The stable key one previewed resource is tracked by: the response id plus its
 * index in the parse output. Independent of the enabled-kind filter, so a
 * settings change never renumbers the resources that survive it.
 */
const resourceKey = (responseId: string, index: number): string => `${responseId}:${index}`

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
 * The candidate one response resolves to: its top-specificity candidate among
 * the enabled kinds, or none when every matching kind is disabled (or nothing
 * matched at all). With no per-response overrides, the default routing pick is
 * the only pick.
 */
const pickFor = <K extends Pick<HttpResponseKind.HttpResponseKind<unknown>, 'name'>>(
  recognized: Extraction.RecognizedResponse<K>,
  enabledKinds: ReadonlySet<string>
): Option.Option<Extraction.RecognitionCandidate<K>> =>
  Arr.head(recognized.candidates.filter((candidate) => enabledKinds.has(candidate.kind.name)))

/**
 * Parse every response the enabled kinds choose through its top-specificity
 * kind, producing one {@link PreviewedResponse} per input response, in input
 * order.
 */
const preview = <TParsed>(
  pool: readonly HttpResponseKind.HttpResponseKind<TParsed>[],
  responses: readonly Extraction.Input[],
  enabledKinds: ReadonlySet<string>
): Effect.Effect<
  readonly PreviewedResponse<HttpResponseKind.HttpResponseKind<TParsed>, TParsed>[]
> => {
  const duplicates = Extraction.findDuplicates(responses)
  return Effect.forEach(
    Arr.zip(responses, Extraction.recognize(pool, responses)),
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
      const pick = pickFor(recognized, enabledKinds)
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

export { pickFor, preview, resourceKey }
export type { PreviewedOutcome, PreviewedResource, PreviewedResponse }
