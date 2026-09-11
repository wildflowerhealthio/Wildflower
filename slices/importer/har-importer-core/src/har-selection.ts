import { Array as Arr, Option } from 'effect'

import { type Extraction, type HttpResponseKind } from 'http-extraction-fundamentals'

/**
 * The HAR-specific routing model: enabled kinds and per-response pick
 * overrides. The per-resource selection (exclude/edit) lives in the general
 * `Review.Selection` in `importer-fundamentals`.
 *
 * @remarks
 * A pure data type + transitions module, following the qualified-namespace
 * convention (`HarSelection.initial`, `HarSelection.toggleKind`, etc.).
 * The preview pipeline that _uses_ these transitions lives in `./review.ts`.
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
interface Selection {
  /** The kind names enabled across the import; a kind absent here is disabled everywhere. */
  readonly enabledKinds: ReadonlySet<string>
  /** Per-response pick overrides, response id → chosen kind name. */
  readonly overrides: ReadonlyMap<string, string>
}

/** A default selection: every kind enabled, no overrides. */
const initial = (pool: readonly NamedKind[]): Selection => ({
  enabledKinds: new Set(pool.map((kind) => kind.name)),
  overrides: new Map(),
})

/** Whether a kind is enabled across the import. */
const isKindEnabled = (selection: Selection, kindName: string): boolean =>
  selection.enabledKinds.has(kindName)

/** Toggle a kind on/off across the whole import. */
const toggleKind = (selection: Selection, kindName: string): Selection => {
  const enabledKinds = new Set(selection.enabledKinds)
  if (enabledKinds.has(kindName)) enabledKinds.delete(kindName)
  else enabledKinds.add(kindName)
  return { ...selection, enabledKinds }
}

/** Override one response's pick to a specific kind by name. */
const overridePick = (selection: Selection, responseId: string, kindName: string): Selection => {
  const overrides = new Map(selection.overrides)
  overrides.set(responseId, kindName)
  return { ...selection, overrides }
}

/** Drop one response's override, returning it to its default pick. */
const clearOverride = (selection: Selection, responseId: string): Selection => {
  const overrides = new Map(selection.overrides)
  overrides.delete(responseId)
  return { ...selection, overrides }
}

/** The candidates for one response that survive the enabled-kind filter, still ranked. */
const enabledCandidates = <K extends NamedKind>(
  recognized: Extraction.RecognizedResponse<K>,
  selection: Selection
): readonly Extraction.RecognitionCandidate<K>[] =>
  recognized.candidates.filter((candidate) => isKindEnabled(selection, candidate.kind.name))

/**
 * The candidate one response resolves to under a selection: the override if it
 * names a still-enabled candidate, else the top-specificity enabled candidate,
 * else none.
 */
const pickFor = <K extends NamedKind>(
  recognized: Extraction.RecognizedResponse<K>,
  selection: Selection
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
  selection: Selection
): number => recognized.filter((response) => Option.isSome(pickFor(response, selection))).length

export {
  chosenCount,
  clearOverride,
  enabledCandidates,
  initial,
  isKindEnabled,
  overridePick,
  pickFor,
  toggleKind,
}
export type { NamedKind, Selection }
