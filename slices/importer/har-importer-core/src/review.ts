import { Array as Arr, Effect, Option, type ParseResult } from 'effect'

import { Extraction, type HttpResponseKind } from 'http-extraction-fundamentals'

/**
 * The HAR-specific per-response review model: whole-import kind toggles,
 * per-response pick overrides, recognition, and preview — the HTTP routing
 * half that only HAR needs. The per-resource selection (exclude/edit) lives
 * in `importer-fundamentals`' `Review` namespace.
 *
 * @packageDocumentation
 */

/** One field every kind exposes that the review reads for identity + display. */
type NamedKind = Pick<HttpResponseKind.HttpResponseKind<unknown>, 'name'>

/**
 * The HAR review's routing state: enabled kinds and per-response pick
 * overrides. The per-resource selection (exclude/edit) is in the general
 * `Review.Selection`.
 */
interface HarSelection {
  /** The kind names enabled across the import; a kind absent here is disabled everywhere. */
  readonly enabledKinds: ReadonlySet<string>
  /** Per-response pick overrides, response id → chosen kind name. */
  readonly overrides: ReadonlyMap<string, string>
}

/** A default HAR selection: every kind enabled, no overrides. */
const initialHarSelection = (pool: readonly NamedKind[]): HarSelection => ({
  enabledKinds: new Set(pool.map((kind) => kind.name)),
  overrides: new Map(),
})

/** Whether a kind is enabled across the import. */
const isKindEnabled = (selection: HarSelection, kindName: string): boolean =>
  selection.enabledKinds.has(kindName)

/** Toggle a kind on/off across the whole import. */
const toggleKind = (selection: HarSelection, kindName: string): HarSelection => {
  const enabledKinds = new Set(selection.enabledKinds)
  if (enabledKinds.has(kindName)) enabledKinds.delete(kindName)
  else enabledKinds.add(kindName)
  return { ...selection, enabledKinds }
}

/** Override one response's pick to a specific kind by name. */
const overridePick = (
  selection: HarSelection,
  responseId: string,
  kindName: string
): HarSelection => {
  const overrides = new Map(selection.overrides)
  overrides.set(responseId, kindName)
  return { ...selection, overrides }
}

/** Drop one response's override, returning it to its default pick. */
const clearOverride = (selection: HarSelection, responseId: string): HarSelection => {
  const overrides = new Map(selection.overrides)
  overrides.delete(responseId)
  return { ...selection, overrides }
}

/**
 * The stable key one previewed resource is tracked by: the response id plus its
 * index in the parse output.
 */
const resourceKey = (responseId: string, index: number): string => `${responseId}:${index}`

/** The candidates for one response that survive the enabled-kind filter, still ranked. */
const enabledCandidates = <K extends NamedKind>(
  recognized: Extraction.RecognizedResponse<K>,
  selection: HarSelection
): readonly Extraction.RecognitionCandidate<K>[] =>
  recognized.candidates.filter((candidate) => isKindEnabled(selection, candidate.kind.name))

/**
 * The candidate one response resolves to under a selection: the override if it
 * names a still-enabled candidate, else the top-specificity enabled candidate,
 * else none.
 */
const pickFor = <K extends NamedKind>(
  recognized: Extraction.RecognizedResponse<K>,
  selection: HarSelection
): Option.Option<Extraction.RecognitionCandidate<K>> => {
  const enabled = enabledCandidates(recognized, selection)
  const overrideName = selection.overrides.get(recognized.ref.id)
  const overridden =
    overrideName === undefined
      ? undefined
      : enabled.find((candidate) => candidate.kind.name === overrideName)
  return overridden === undefined ? Arr.head(enabled) : Option.some(overridden)
}

/** How many of a recognized set resolve to a chosen pick under a selection. */
const chosenCount = <K extends NamedKind>(
  recognized: readonly Extraction.RecognizedResponse<K>[],
  selection: HarSelection
): number => recognized.filter((response) => Option.isSome(pickFor(response, selection))).length

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

// A duplicate response never routes to a kind, so the pick reads as `None`.
const DUPLICATE_PICK: Option.Option<string> = Option.none()

/**
 * Parse every response the selection chose through its chosen kind, producing
 * one {@link PreviewedResponse} per input response, in input order.
 */
const preview = <TParsed>(
  pool: readonly HttpResponseKind.HttpResponseKind<TParsed>[],
  responses: readonly Extraction.Input[],
  selection: HarSelection
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
      const pick = pickFor(recognized, selection)
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

export {
  chosenCount,
  clearOverride,
  enabledCandidates,
  initialHarSelection,
  isKindEnabled,
  overridePick,
  pickFor,
  preview,
  recognize,
  resourceKey,
  toggleKind,
}
export type { HarSelection, NamedKind, PreviewedOutcome, PreviewedResource, PreviewedResponse }
