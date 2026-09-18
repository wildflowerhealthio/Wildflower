import { Option } from 'effect'
import { type FhirResource } from 'fhir-r4/resources'

import type * as DecodedFile from './decoded-file.ts'

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
 */
interface Selection {
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
  readonly resourceOverrides: ReadonlyMap<string, FhirResource>
}

/** The default selection: every resource included, no edits. */
const initial = (): Selection => ({
  excludedResources: new Set(),
  resourceOverrides: new Map(),
})

/** Whether a resource is included in the confirm's write set. */
const isResourceIncluded = (selection: Selection, key: string): boolean =>
  !selection.excludedResources.has(key)

/**
 * Toggle one resource in or out of the confirm's write set. A resource keyed
 * here is opted out at confirm and never written.
 */
const toggleResource = (selection: Selection, key: string): Selection => {
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
const setResourcesIncluded = (
  selection: Selection,
  keys: Iterable<string>,
  included: boolean
): Selection => {
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
const edit = (selection: Selection, key: string, resource: FhirResource): Selection => {
  const resourceOverrides = new Map(selection.resourceOverrides)
  resourceOverrides.set(key, resource)
  return { ...selection, resourceOverrides }
}

/**
 * Drop the edit override at `key`, restoring the resolved original at confirm.
 * A no-op when no override is set.
 */
const revert = (selection: Selection, key: string): Selection => {
  if (!selection.resourceOverrides.has(key)) return selection
  const resourceOverrides = new Map(selection.resourceOverrides)
  resourceOverrides.delete(key)
  return { ...selection, resourceOverrides }
}

/** Whether the reviewer has set an inline edit for `key`. */
const isResourceEdited = (selection: Selection, key: string): boolean =>
  selection.resourceOverrides.has(key)

/** The edit override at `key`, when the reviewer has set one — else `None`. */
const editedResource = (selection: Selection, key: string): Option.Option<FhirResource> => {
  const override = selection.resourceOverrides.get(key)
  return override === undefined ? Option.none() : Option.some(override)
}

/**
 * The confirm's write set: every labeled resource the reviewer left included,
 * with any inline edit substituted in, in resolve order.
 *
 * @param labeled - The labeled resources from the format's `resolve`
 * @param selection - The reviewer's per-resource choices
 * @returns The resources to write, each replaced by its edit override when the
 *   reviewer has set one
 */
const chosenResources = (
  labeled: readonly DecodedFile.Resource[],
  selection: Selection
): readonly FhirResource[] =>
  labeled
    .filter((entry) => isResourceIncluded(selection, entry.key))
    .map((entry) => selection.resourceOverrides.get(entry.key) ?? entry.resource)

/** How many labeled resources are included under a selection. */
const includedCount = (labeled: readonly DecodedFile.Resource[], selection: Selection): number =>
  chosenResources(labeled, selection).length

/** How many labeled resources are excluded under a selection. */
const excludedCount = (labeled: readonly DecodedFile.Resource[], selection: Selection): number =>
  labeled.filter((entry) => !isResourceIncluded(selection, entry.key)).length

export {
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
export type { Selection }
