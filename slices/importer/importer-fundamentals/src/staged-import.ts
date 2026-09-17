import { Option } from 'effect'

import type { LabeledResource } from './file-importer-descriptor.ts'

/**
 * The pure model of an import that has been decoded but not yet written: which
 * of its resources are opted out, and which carry an inline edit, against the
 * flat list of labeled resources the format's decode produced.
 *
 * @remarks
 * "Staged" in the sense the name carries elsewhere — resources sitting between
 * decode and confirm, where the reviewer can still change what goes. What the
 * UI renders over this is *a* review; the model is the staged import itself,
 * and outlives any particular way of reviewing it.
 *
 * Both axes key by {@link LabeledResource.key} so the state stays serializable
 * and survives a settings re-decode: a key the new decode no longer produces
 * simply stops applying, rather than dangling.
 *
 * @packageDocumentation
 */

/**
 * A whole review's per-resource selection state: which resources are excluded
 * and which have inline edits. A plain value the shell holds and threads
 * through the pure transitions below.
 *
 * @typeParam TParsed - The resource type edit overrides carry — the same
 *   `TParsed` the format resolves to. A callsite that never touches
 *   overrides passes `unknown`.
 */
interface Selection<TParsed> {
  /**
   * Per-resource exclusions, keyed by {@link LabeledResource.key} — a resource
   * whose key is here is opted out at confirm and never written. Every resource
   * defaults to included; the set holds only the explicit opt-outs.
   */
  readonly excludedResources: ReadonlySet<string>
  /**
   * Per-resource edit overrides, keyed by {@link LabeledResource.key} — a
   * resource whose key is here has its parsed value replaced by the edited one
   * at confirm.
   */
  readonly resourceOverrides: ReadonlyMap<string, TParsed>
}

/** The default selection: every resource included, no edits. */
const initial = <TParsed>(): Selection<TParsed> => ({
  excludedResources: new Set(),
  resourceOverrides: new Map(),
})

/** Whether a resource is included in the confirm's write set. */
const isResourceIncluded = (selection: Selection<unknown>, key: string): boolean =>
  !selection.excludedResources.has(key)

/**
 * Toggle one resource in or out of the confirm's write set. A resource keyed
 * here is opted out at confirm and never written.
 */
const toggleResource = <TParsed>(
  selection: Selection<TParsed>,
  key: string
): Selection<TParsed> => {
  const excludedResources = new Set(selection.excludedResources)
  if (excludedResources.has(key)) excludedResources.delete(key)
  else excludedResources.add(key)
  return { ...selection, excludedResources }
}

/**
 * Include or exclude several resources at once — the batch form of
 * {@link toggleResource}, so a reviewer can opt a whole section in or out in a
 * single action. `included: false` opts every listed key out; `included: true`
 * clears the opt-out on every listed key. Keys not listed are left untouched,
 * and a key already in the wanted state is a no-op.
 */
const setResourcesIncluded = <TParsed>(
  selection: Selection<TParsed>,
  keys: Iterable<string>,
  included: boolean
): Selection<TParsed> => {
  const excludedResources = new Set(selection.excludedResources)
  for (const key of keys) {
    if (included) excludedResources.delete(key)
    else excludedResources.add(key)
  }
  return { ...selection, excludedResources }
}

/**
 * Replace the resource at `key` with `resource` — the reviewer's inline edit.
 * `chosenResources` returns the override in place of the resolved value.
 */
const edit = <TParsed>(
  selection: Selection<TParsed>,
  key: string,
  resource: TParsed
): Selection<TParsed> => {
  const resourceOverrides = new Map(selection.resourceOverrides)
  resourceOverrides.set(key, resource)
  return { ...selection, resourceOverrides }
}

/**
 * Drop the edit override at `key`, restoring the resolved original at confirm.
 * A no-op when no override is set.
 */
const revert = <TParsed>(selection: Selection<TParsed>, key: string): Selection<TParsed> => {
  if (!selection.resourceOverrides.has(key)) return selection
  const resourceOverrides = new Map(selection.resourceOverrides)
  resourceOverrides.delete(key)
  return { ...selection, resourceOverrides }
}

/** Whether the reviewer has set an inline edit for `key`. */
const isResourceEdited = (selection: Selection<unknown>, key: string): boolean =>
  selection.resourceOverrides.has(key)

/** The edit override at `key`, when the reviewer has set one — else `None`. */
const editedResource = <TParsed>(
  selection: Selection<TParsed>,
  key: string
): Option.Option<TParsed> => {
  const override = selection.resourceOverrides.get(key)
  return override === undefined ? Option.none() : Option.some(override)
}

/**
 * One chosen resource carried with the review key it was chosen under — the
 * key-preserving unit of the confirm's write set. The key lets a downstream
 * consumer (the provenance-stamping confirm, a planned `planFormatWrite`)
 * distinguish a file's source file from its extracted resources by its stable
 * key rather than by re-recognizing its coding.
 */
interface ChosenEntry<TParsed> {
  readonly key: string
  readonly resource: TParsed
}

/**
 * The confirm's write set with keys preserved: every labeled resource the
 * reviewer left included, with any inline edit substituted in, carried
 * alongside its {@link Selection} key, in resolve order.
 *
 * @param labeled - The labeled resources from the format's `resolve`
 * @param selection - The reviewer's per-resource choices
 * @returns The chosen entries, each replaced by its edit override when the
 *   reviewer has set one
 */
const chosenEntries = <TParsed>(
  labeled: readonly LabeledResource<TParsed>[],
  selection: Selection<TParsed>
): readonly ChosenEntry<TParsed>[] =>
  labeled
    .filter((entry) => isResourceIncluded(selection, entry.key))
    .map((entry) => ({
      key: entry.key,
      resource: selection.resourceOverrides.get(entry.key) ?? entry.resource,
    }))

/**
 * The confirm's write set: every labeled resource the reviewer left included,
 * with any inline edit substituted in, in resolve order.
 *
 * @param labeled - The labeled resources from the format's `resolve`
 * @param selection - The reviewer's per-resource choices
 * @returns The resources to write, each replaced by its edit override when the
 *   reviewer has set one
 */
const chosenResources = <TParsed>(
  labeled: readonly LabeledResource<TParsed>[],
  selection: Selection<TParsed>
): readonly TParsed[] => chosenEntries(labeled, selection).map((entry) => entry.resource)

/** How many labeled resources are included under a selection. */
const includedCount = <TParsed>(
  labeled: readonly LabeledResource<TParsed>[],
  selection: Selection<TParsed>
): number => chosenResources(labeled, selection).length

/** How many labeled resources are excluded under a selection. */
const excludedCount = (
  labeled: readonly LabeledResource<unknown>[],
  selection: Selection<unknown>
): number => labeled.filter((entry) => !isResourceIncluded(selection, entry.key)).length

export {
  chosenEntries,
  chosenResources,
  edit,
  editedResource,
  excludedCount,
  includedCount,
  initial,
  isResourceEdited,
  isResourceIncluded,
  revert,
  setResourcesIncluded,
  toggleResource,
}
export type { ChosenEntry, Selection }
