import type { FhirResourceWithId } from '@wildflowerhealthio/fhir-r4/resources'
import { Option } from 'effect'

import type * as DecodedFile from './decoded-file.ts'
import * as FileResolution from './identity-map/file-resolution.ts'
import type * as LinkPlan from './identity-map/link-plan.ts'

/**
 * The pure model of an import that has been decoded but not yet written: which
 * of its resources the reviewer included or excluded, and which carry an
 * inline edit, against the flat list of labeled resources the format's decode
 * produced.
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
 * A whole review's per-resource selection state: what the reviewer included
 * or excluded by hand, and which resources have inline edits. A plain value
 * the shell holds and threads through the pure transitions below.
 *
 * @remarks
 * Only what the reviewer did is held. Whether a resource they never ticked
 * or unticked is written is the review's default, which the shell derives
 * from the batch as it is now (a resource the server already holds, or one
 * left without a patient, is out by default) and passes in as
 * `excludedByDefault`, so a link change that gives a resource its patient
 * takes it back in.
 */
interface Selection {
  /**
   * The reviewer's own include/exclude choices, keyed by
   * {@link LabeledResource.key}: `true` for a resource they ticked, `false`
   * for one they unticked. A choice stands whatever the default becomes; a
   * key absent here takes the default.
   */
  readonly includedByReviewer: ReadonlyMap<string, boolean>
  /**
   * Per-resource edit overrides, keyed by {@link LabeledResource.key} — a
   * resource whose key is here has its parsed value replaced by the edited one
   * at confirm, resolved on the batch's plan (`FileResolution.resolveEdit`).
   */
  readonly resourceOverrides: ReadonlyMap<string, FhirResourceWithId>
}

/** The selection before the reviewer does anything: no choices, no edits. */
const initial = (): Selection => ({
  includedByReviewer: new Map(),
  resourceOverrides: new Map(),
})

/**
 * Whether a resource is included in the confirm's write set: the reviewer's
 * choice for it, else not when its key is in `excludedByDefault`.
 */
const isResourceIncluded = (
  selection: Selection,
  excludedByDefault: ReadonlySet<string>,
  key: string
): boolean => selection.includedByReviewer.get(key) ?? !excludedByDefault.has(key)

/**
 * Include or exclude several resources at once, as the reviewer's choice for
 * each, so a reviewer can opt a whole section in or out in a single action.
 * Keys not listed are left untouched.
 */
const setResourcesIncluded = (
  selection: Selection,
  keys: Iterable<string>,
  included: boolean
): Selection => {
  const includedByReviewer = new Map(selection.includedByReviewer)
  for (const key of keys) includedByReviewer.set(key, included)
  return { ...selection, includedByReviewer }
}

/**
 * Toggle one resource in or out of the confirm's write set: the reviewer's
 * choice for it becomes the opposite of whether it is included now.
 */
const toggleResource = (
  selection: Selection,
  excludedByDefault: ReadonlySet<string>,
  key: string
): Selection =>
  setResourcesIncluded(selection, [key], !isResourceIncluded(selection, excludedByDefault, key))

/**
 * Replace the resource at `key` with `resource` — the reviewer's inline edit.
 * `editedResource` reads the override back; a write plan substitutes it for the decoded value.
 */
const edit = (selection: Selection, key: string, resource: FhirResourceWithId): Selection => {
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
const editedResource = (selection: Selection, key: string): Option.Option<FhirResourceWithId> => {
  const override = selection.resourceOverrides.get(key)
  return override === undefined ? Option.none() : Option.some(override)
}

/**
 * The resource the review writes for `resolvedEntry`, a row of a file
 * resolved on `plan`: the edit override at its key resolved on the plan
 * (`FileResolution.resolveEdit`), else the entry's own resource.
 */
const resolvedResourceOf = (
  plan: LinkPlan.Type,
  selection: Selection,
  resolvedEntry: DecodedFile.Resource
): FhirResourceWithId =>
  Option.match(editedResource(selection, resolvedEntry.key), {
    onNone: () => resolvedEntry.resource,
    onSome: FileResolution.resolveEdit(plan, resolvedEntry.key),
  })

export {
  edit,
  editedResource,
  initial,
  isResourceEdited,
  isResourceIncluded,
  resolvedResourceOf,
  revert,
  setResourcesIncluded,
  toggleResource,
}
export type { Selection }
