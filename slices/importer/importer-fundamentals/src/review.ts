import { Array as Arr, Effect, Option, type ParseResult, pipe } from 'effect'

import { Extraction, type HttpResponseKind } from 'http-extraction-fundamentals'

// A duplicate response never routes to a kind, so the pick reads as `None`.
const DUPLICATE_PICK: Option.Option<string> = Option.none()

/**
 * The pure per-response review model: whole-import kind toggles, per-response
 * pick overrides, and per-resource include toggles, resolved against ranked
 * recognition and previewed parses. The interactive `ReviewBody` a format's
 * React package renders is a view over these transitions — see this package's
 * AGENTS.md for the model's rationale (per-response choices, serializable
 * name-keyed overrides, key-scoped exclusions, untouched review == what the
 * `runExtraction` reference model would write).
 *
 * @packageDocumentation
 */

/** One field every kind exposes that the review reads for identity + display. */
type NamedKind = Pick<HttpResponseKind.HttpResponseKind<unknown>, 'name'>

/**
 * A whole review's selection state: the enabled kinds, per-response pick
 * overrides, and per-resource exclusions. A plain value the shell holds and
 * threads through the pure transitions below.
 */
interface Selection {
  /** The kind names enabled across the import; a kind absent here is disabled everywhere. */
  readonly enabledKinds: ReadonlySet<string>
  /** Per-response pick overrides, response id → chosen kind name. */
  readonly overrides: ReadonlyMap<string, string>
  /**
   * Per-resource exclusions, keyed by {@link resourceKey} — a resource whose
   * key is here is opted out at confirm and never written. Every resource
   * defaults to included; the set holds only the explicit opt-outs.
   */
  readonly excludedResources: ReadonlySet<string>
}

/**
 * The default selection for a pool: every kind enabled, no overrides, every
 * previewed resource included — so each response defaults to its top-specificity
 * candidate and a fresh review writes what the reference model would.
 */
const initial = (pool: readonly NamedKind[]): Selection => ({
  enabledKinds: new Set(pool.map((kind) => kind.name)),
  overrides: new Map(),
  excludedResources: new Set(),
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
  return {
    enabledKinds,
    overrides: selection.overrides,
    excludedResources: selection.excludedResources,
  }
}

/** Override one response's pick to a specific kind by name. */
const overridePick = (selection: Selection, responseId: string, kindName: string): Selection => {
  const overrides = new Map(selection.overrides)
  overrides.set(responseId, kindName)
  return {
    enabledKinds: selection.enabledKinds,
    overrides,
    excludedResources: selection.excludedResources,
  }
}

/** Drop one response's override, returning it to its default pick. */
const clearOverride = (selection: Selection, responseId: string): Selection => {
  const overrides = new Map(selection.overrides)
  overrides.delete(responseId)
  return {
    enabledKinds: selection.enabledKinds,
    overrides,
    excludedResources: selection.excludedResources,
  }
}

/**
 * The stable key one previewed resource is tracked by: the response id plus its
 * index in the parse output. Every previewed resource carries this key so a
 * per-resource toggle can add or drop the exact resource without depending on
 * object identity.
 *
 * @remarks
 * Response ids are unique within one file's decoded responses (each response is
 * a distinct archive entry), so within one `Selection` these keys are unique.
 * A caller composing a batch-wide key across files (a React `key` over several
 * files, say) prefixes with the file id.
 */
const resourceKey = (responseId: string, index: number): string => `${responseId}:${index}`

/** Whether a previewed resource is included in the confirm's write set. */
const isResourceIncluded = (selection: Selection, key: string): boolean =>
  !selection.excludedResources.has(key)

/**
 * Toggle one previewed resource in or out of the confirm's write set. A
 * resource keyed here is opted out at confirm and never written.
 */
const toggleResource = (selection: Selection, key: string): Selection => {
  const excludedResources = new Set(selection.excludedResources)
  if (excludedResources.has(key)) excludedResources.delete(key)
  else excludedResources.add(key)
  return {
    enabledKinds: selection.enabledKinds,
    overrides: selection.overrides,
    excludedResources,
  }
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
 * count of responses that will be parsed at preview.
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
 * One previewed resource: the parsed value plus its stable key. The key
 * survives selection changes so a per-resource opt-out from the review carries
 * through to what the confirm writes.
 */
interface PreviewedResource<TParsed> {
  readonly key: string
  readonly resource: TParsed
}

/**
 * One response's preview outcome — every non-resource outcome folded to data so
 * `preview` is total and one bad response cannot abort the batch.
 *
 * @remarks
 * `noPick` names a response no enabled kind claimed (or whose override, plus a
 * disabled default, resolved to nothing). `parseError` names a response whose
 * chosen `parse` failed — the response contributes nothing but the failure is
 * listed against its URL so the reviewer can see why.
 */
type PreviewedOutcome<TParsed> =
  | { readonly _tag: 'resources'; readonly resources: readonly PreviewedResource<TParsed>[] }
  | { readonly _tag: 'parseError'; readonly error: ParseResult.ParseError }
  | { readonly _tag: 'bodyAbsent' }
  | { readonly _tag: 'noPick' }
  /** A response whose `(url, method, body)` matched an earlier one in the
   * same batch. Never parsed; `of` is the first-seen response's `ref`. */
  | { readonly _tag: 'duplicate'; readonly of: Extraction.ResponseRef }

/**
 * One response's preview: its recognition, its resolved pick, and its parse
 * outcome. The `ReviewBody` reads these per URL to show which resources would
 * be written and to render each resource's include toggle.
 */
interface PreviewedResponse<K, TParsed> {
  readonly ref: Extraction.ResponseRef
  readonly recognized: Extraction.RecognizedResponse<K>
  /** The resolved pick's kind name, or `None` when nothing was chosen. */
  readonly pickKindName: Option.Option<string>
  readonly outcome: PreviewedOutcome<TParsed>
}

/**
 * Parse every response the selection chose through its chosen kind, producing
 * one {@link PreviewedResponse} per input response, in input order.
 *
 * @typeParam TParsed - The resource type the pool decodes to
 * @param pool - The format's response kinds
 * @param responses - The decoded responses, in input order
 * @param selection - The reviewer's choices — determines which candidate is
 *   parsed for each response, if any
 * @returns One entry per input response, its recognition, resolved pick, and
 *   parse outcome (`resources` with stable per-resource keys, `parseError` for
 *   a parse failure, `bodyAbsent` for a response whose archive carried no body,
 *   `noPick` for a response no enabled kind claimed)
 *
 * @remarks
 * The read half's resource-level model: `preview` runs `parse` at preview time
 * so the reviewer sees exactly what would be written, keys each parsed resource
 * so opt-outs survive re-renders, and folds every non-resource outcome to data
 * so the read half stays total and infallible.
 */
const preview = <TParsed>(
  pool: readonly HttpResponseKind.HttpResponseKind<TParsed>[],
  responses: readonly Extraction.Input[],
  selection: Selection
): Effect.Effect<
  readonly PreviewedResponse<HttpResponseKind.HttpResponseKind<TParsed>, TParsed>[]
> => {
  // Detect duplicates once before recognition/parse: a repeated
  // `(url, method, body)` is data, and the second occurrence contributes
  // nothing beyond the first — same bytes, same parsed resources.
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

/**
 * The confirm's write set: every previewed resource the reviewer left included,
 * flattened in preview order.
 *
 * @param previews - The previewed responses from {@link preview}
 * @param selection - The reviewer's choices — reads only the exclusion set;
 *   picks and kind toggles are already resolved by the preview
 * @returns The parsed resources to write, verbatim from the preview — no
 *   re-parse, so a confirm writes the same objects the reviewer inspected
 */
const chosenResources = <K, TParsed>(
  previews: readonly PreviewedResponse<K, TParsed>[],
  selection: Selection
): readonly TParsed[] =>
  previews.flatMap((entry) =>
    entry.outcome._tag === 'resources'
      ? entry.outcome.resources
          .filter((resource) => isResourceIncluded(selection, resource.key))
          .map((resource) => resource.resource)
      : []
  )

/** How many previewed resources are included under a selection — the confirm's write count. */
const includedCount = <K, TParsed>(
  previews: readonly PreviewedResponse<K, TParsed>[],
  selection: Selection
): number => chosenResources(previews, selection).length

/** How many previewed resources are excluded under a selection. */
const excludedCount = <K, TParsed>(
  previews: readonly PreviewedResponse<K, TParsed>[],
  selection: Selection
): number =>
  previews.reduce((total, entry) => {
    if (entry.outcome._tag !== 'resources') return total
    return (
      total +
      entry.outcome.resources.filter((resource) => !isResourceIncluded(selection, resource.key))
        .length
    )
  }, 0)

/** What {@link chosen} returns: the decoded resources plus counts of non-resource outcomes. */
interface ChosenOutcome<TParsed> {
  readonly resources: readonly TParsed[]
  readonly parseFailures: number
  readonly bodyAbsent: number
}

/**
 * Decode the chosen responses in one pass and fold to the confirm's write set —
 * the pre-V1 helper preserved for tests and callers that don't need a preview.
 *
 * @remarks
 * {@link preview} plus {@link chosenResources} is the interactive path (parse
 * runs at preview so a reviewer sees exactly what would be written); this
 * helper does the same reduction in one shot.
 *
 * @typeParam TParsed - The resource type the pool decodes to
 * @param pool - The format's response kinds
 * @param responses - The decoded responses, in input order
 * @param selection - The reviewer's choices
 * @returns The included resources plus counts of parse failures and absent
 *   bodies so a caller can surface them
 */
const chosen = <TParsed>(
  pool: readonly HttpResponseKind.HttpResponseKind<TParsed>[],
  responses: readonly Extraction.Input[],
  selection: Selection
): Effect.Effect<ChosenOutcome<TParsed>> =>
  pipe(
    preview(pool, responses, selection),
    Effect.map((previews) => ({
      resources: chosenResources(previews, selection),
      parseFailures: previews.filter((entry) => entry.outcome._tag === 'parseError').length,
      bodyAbsent: previews.filter((entry) => entry.outcome._tag === 'bodyAbsent').length,
    }))
  )

export {
  chosen,
  chosenCount,
  chosenResources,
  clearOverride,
  enabledCandidates,
  excludedCount,
  includedCount,
  initial,
  isKindEnabled,
  isResourceIncluded,
  overridePick,
  pickFor,
  preview,
  recognize,
  resourceKey,
  toggleKind,
  toggleResource,
}
export type {
  ChosenOutcome,
  NamedKind,
  PreviewedOutcome,
  PreviewedResource,
  PreviewedResponse,
  Selection,
}
