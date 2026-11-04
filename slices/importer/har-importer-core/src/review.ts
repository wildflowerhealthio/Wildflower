import { Array as Arr, Effect, Match, Option, type ParseResult } from 'effect'

import {
  Extraction,
  type HttpResponseKind,
  type SystemFamily,
} from '@wildflowerhealthio/http-extraction-fundamentals'

/**
 * The HAR-specific preview pipeline: given decoded responses and the enabled
 * kind names, recognize each response against the kind pool and parse the
 * chosen ones into previewed records, each detached under the system family
 * its kind recognized the response with. The importer's decode folds these
 * previews into the sections and notes the shell reviews; the per-resource
 * selection (exclude/edit) lives in `importer-fundamentals`' `StagedImport`
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

/** One previewed record: the record plus its stable key. */
interface PreviewedResource<TRecord> {
  readonly key: string
  readonly resource: TRecord
}

/**
 * One response's preview outcome — every non-resource outcome folded to data so
 * `preview` is total and one bad response cannot abort the batch.
 *
 * @remarks
 * `noSystemFamily` is a response whose picked kind recognized it without
 * minting a system family: nothing says which namespace the ids it would
 * parse belong to, so it is not parsed, and yields no records rather than
 * keyless ones.
 */
type PreviewedOutcome<TRecord> =
  | { readonly _tag: 'resources'; readonly resources: readonly PreviewedResource<TRecord>[] }
  | { readonly _tag: 'parseError'; readonly error: ParseResult.ParseError }
  | { readonly _tag: 'bodyAbsent' }
  | { readonly _tag: 'noPick' }
  | { readonly _tag: 'noSystemFamily' }
  | { readonly _tag: 'duplicate'; readonly of: Extraction.ResponseRef }

/** One response's preview: recognition, resolved pick, and parse outcome. */
interface PreviewedResponse<K, TRecord> {
  readonly ref: Extraction.ResponseRef
  readonly recognized: Extraction.RecognizedResponse<K>
  readonly pickKindName: Option.Option<string>
  readonly outcome: PreviewedOutcome<TRecord>
}

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
 * kind, each parsed resource detached under the system family that kind's
 * recognition minted, producing one {@link PreviewedResponse} per input
 * response, in input order.
 *
 * @param pool - The kinds to route through
 * @param responses - The archive's responses
 * @param enabledKinds - The names of the kinds the settings leave on
 * @param detachUnder - How a resource of one response is detached, given the
 *   family its kind recognized the response with (`fhir-r4-adoption`'s
 *   `detach`); the family is read off the pick, so `tryRecognize` runs once
 *   per response
 */
const preview = <TParsed, TRecord>(
  pool: readonly HttpResponseKind.HttpResponseKind<TParsed>[],
  responses: readonly Extraction.Input[],
  enabledKinds: ReadonlySet<string>,
  detachUnder: (systemFamily: SystemFamily.Type) => (parsed: TParsed) => TRecord
): Effect.Effect<
  readonly PreviewedResponse<HttpResponseKind.HttpResponseKind<TParsed>, TRecord>[]
> => {
  type Previewed = PreviewedResponse<HttpResponseKind.HttpResponseKind<TParsed>, TRecord>
  const duplicates = Extraction.findDuplicates(responses)
  return Effect.forEach(
    Arr.zip(responses, Extraction.recognize(pool, responses)),
    ([response, recognized]) => {
      const duplicateOf = duplicates.get(response.id)
      if (duplicateOf !== undefined) {
        return Effect.succeed<Previewed>({
          ref: recognized.ref,
          recognized,
          pickKindName: Option.none(),
          outcome: { _tag: 'duplicate', of: duplicateOf },
        })
      }
      const pick = pickFor(recognized, enabledKinds)
      if (Option.isNone(pick)) {
        return Effect.succeed<Previewed>({
          ref: recognized.ref,
          recognized,
          pickKindName: Option.none(),
          outcome: { _tag: 'noPick' },
        })
      }
      const candidate = pick.value
      const pickKindName = Option.some(candidate.kind.name)
      const { systemFamily } = candidate.recognized
      if (systemFamily === undefined) {
        return Effect.succeed<Previewed>({
          ref: recognized.ref,
          recognized,
          pickKindName,
          outcome: { _tag: 'noSystemFamily' },
        })
      }
      const detach = detachUnder(systemFamily)
      return Extraction.parseWith(candidate.kind, response).pipe(
        Effect.map((outcome): Previewed => {
          const previewed = Match.value(outcome).pipe(
            Match.tag('resources', ({ resources }): PreviewedOutcome<TRecord> => ({
              _tag: 'resources',
              resources: resources.map((resource, index): PreviewedResource<TRecord> => ({
                key: resourceKey(recognized.ref.id, index),
                resource: detach(resource),
              })),
            })),
            Match.tag('parseError', ({ error }): PreviewedOutcome<TRecord> => ({
              _tag: 'parseError',
              error,
            })),
            Match.tag('bodyAbsent', (): PreviewedOutcome<TRecord> => ({ _tag: 'bodyAbsent' })),
            Match.exhaustive
          )
          return { ref: recognized.ref, recognized, pickKindName, outcome: previewed }
        })
      )
    }
  )
}

export { pickFor, preview, resourceKey }
export type { PreviewedOutcome, PreviewedResource, PreviewedResponse }
