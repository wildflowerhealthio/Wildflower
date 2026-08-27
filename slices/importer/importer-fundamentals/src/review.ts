import { Array as Arr, Effect, Option, pipe } from 'effect'

import { Extraction, type HttpResponseKind } from 'http-extraction-fundamentals'

/**
 * The per-response review model: which response kinds are enabled across the
 * whole import, and which single response overrides its default pick. Built on
 * `Extraction.recognize` / `parseWith`, resource-agnostic, and UI-framework-free
 * — the interactive `ReviewBody` a format's React package renders is a view over
 * these pure transitions.
 *
 * @remarks
 * Recognition is per-response now (each URL routed independently against the
 * pool), so a review is a set of choices *per response*, not one winning source
 * for a whole archive. Two axes of choice:
 *
 * - **Whole-import kind toggles** ({@link enabledKinds}) — disabling a kind
 *   removes it from *every* response's candidates at once, and each response
 *   re-derives its pick from what remains. This is the "I don't want any
 *   Observations from this archive" control.
 * - **Per-response overrides** ({@link overrides}) — on the rare response two
 *   kinds both claim (a real cross-source overlap), a reviewer can pick the
 *   non-default one. Keyed by response id → kind **name** (not the candidate
 *   object) because selection state must be serializable; the candidate objects
 *   that carry the kind for execution are re-derived from recognition each time.
 *
 * The default pick for a response is the top-specificity candidate among the
 * enabled kinds — exactly what routing would choose — so an untouched review
 * writes what `Extraction.run` would have.
 *
 * @packageDocumentation
 */

/** One field every kind exposes that the review reads for identity + display. */
type NamedKind = Pick<HttpResponseKind.HttpResponseKind<unknown>, 'name'>

/**
 * A whole review's selection state: the enabled kinds and the per-response
 * overrides. A plain value the shell holds and threads through the pure
 * transitions below.
 */
interface Selection {
  /** The kind names enabled across the import; a kind absent here is disabled everywhere. */
  readonly enabledKinds: ReadonlySet<string>
  /** Per-response pick overrides, response id → chosen kind name. */
  readonly overrides: ReadonlyMap<string, string>
}

/**
 * The default selection for a pool: every kind enabled, no overrides — so each
 * response defaults to its top-specificity candidate.
 */
const initial = (pool: readonly NamedKind[]): Selection => ({
  enabledKinds: new Set(pool.map((kind) => kind.name)),
  overrides: new Map(),
})

/** Whether a kind is enabled across the import. */
const isKindEnabled = (selection: Selection, kindName: string): boolean =>
  selection.enabledKinds.has(kindName)

/**
 * Toggle a kind on/off across the whole import. Every response re-derives its
 * pick from the new enabled set — a response whose only candidate was the
 * disabled kind now resolves to no pick.
 */
const toggleKind = (selection: Selection, kindName: string): Selection => {
  const enabledKinds = new Set(selection.enabledKinds)
  if (enabledKinds.has(kindName)) enabledKinds.delete(kindName)
  else enabledKinds.add(kindName)
  return { enabledKinds, overrides: selection.overrides }
}

/** Override one response's pick to a specific kind by name. */
const overridePick = (selection: Selection, responseId: string, kindName: string): Selection => {
  const overrides = new Map(selection.overrides)
  overrides.set(responseId, kindName)
  return { enabledKinds: selection.enabledKinds, overrides }
}

/** Drop one response's override, returning it to its default pick. */
const clearOverride = (selection: Selection, responseId: string): Selection => {
  const overrides = new Map(selection.overrides)
  overrides.delete(responseId)
  return { enabledKinds: selection.enabledKinds, overrides }
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
 *
 * @typeParam K - The concrete kind type recognition carried (its `parse` rides
 *   through, so a caller hands the chosen `candidate.kind` straight to
 *   {@link Extraction.parseWith})
 * @returns `Some` the chosen candidate, or `None` when no enabled kind claims
 *   this response
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
  // The `candidates` are pre-sorted most-specific first, so the head is the
  // default pick; an override wins only when it still names an enabled candidate.
  return overridden === undefined ? Arr.head(enabled) : Option.some(overridden)
}

/**
 * How many of a recognized set resolve to a chosen pick under a selection — the
 * pure gate the UI shows a confirm for, without decoding anything.
 */
const chosenCount = <K extends NamedKind>(
  recognized: readonly Extraction.RecognizedResponse<K>[],
  selection: Selection
): number => recognized.filter((response) => Option.isSome(pickFor(response, selection))).length

/**
 * Recognize each response against the pool, keeping every claiming kind ranked —
 * the input a `ReviewBody` renders its per-response pickers from. Re-exported so
 * a format's React package reads recognition through this package rather than
 * reaching into `http-extraction-fundamentals`.
 */
const recognize = Extraction.recognize

/**
 * Decode only the chosen responses — the confirm's write set.
 *
 * @typeParam TResource - The resource type the pool decodes to
 * @param pool - The format's response kinds
 * @param responses - The decoded responses, in input order
 * @param selection - The reviewer's choices
 * @returns The resources of every chosen response that decoded, flattened in
 *   input order — never failing (a decode error or absent body contributes
 *   nothing, exactly as `Extraction.run` reports them as data)
 *
 * @remarks
 * Choose-then-persist: a response with no chosen pick (its kind disabled, or no
 * kind claimed it) is never decoded, so a confirm writes only what the reviewer
 * opted into. `Extraction.parseWith` folds every non-resource outcome to `[]`,
 * so this is total.
 */
const chosen = <TResource>(
  pool: readonly HttpResponseKind.HttpResponseKind<TResource>[],
  responses: readonly Extraction.Input[],
  selection: Selection
): Effect.Effect<readonly TResource[]> =>
  pipe(
    Effect.forEach(Arr.zip(responses, recognize(pool, responses)), ([response, recognized]) =>
      Option.match(pickFor(recognized, selection), {
        onNone: () => Effect.succeed<readonly TResource[]>([]),
        onSome: (candidate) =>
          Extraction.parseWith(candidate.kind, response).pipe(
            Effect.map((outcome) => (outcome._tag === 'resources' ? outcome.resources : []))
          ),
      })
    ),
    Effect.map(Arr.flatten)
  )

export {
  chosen,
  chosenCount,
  clearOverride,
  enabledCandidates,
  initial,
  isKindEnabled,
  overridePick,
  pickFor,
  recognize,
  toggleKind,
}
export type { NamedKind, Selection }
