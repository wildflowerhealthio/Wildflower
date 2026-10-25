import { type FhirResource } from '@wildflowerhealthio/fhir-r4/resources'
import { Option } from 'effect'

import type * as DecodedFile from './decoded-file.ts'
import * as PatientIdentity from './patient-identity.ts'

/**
 * The pure model of an import that has been decoded but not yet written: which
 * of its resources are opted out, which carry an inline edit, and which person
 * each source Patient goes to, against the flat list of labeled resources the
 * format's decode produced.
 *
 * @remarks
 * "Staged" in the sense the name carries elsewhere — resources sitting between
 * decode and confirm, where the reviewer can still change what goes. What the
 * UI renders over this is *a* review; the model is the staged import itself,
 * and outlives any particular way of reviewing it.
 *
 * Every axis keys by {@link LabeledResource.key} so the state stays serializable
 * and survives a settings re-decode: a key the new decode no longer produces
 * simply stops applying, rather than dangling.
 *
 * @packageDocumentation
 */

/**
 * A whole review's per-resource selection state: which resources are excluded,
 * which have inline edits, and where each source Patient goes. A plain value
 * the shell holds and threads through the pure transitions below.
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
  /**
   * Per-source-Patient assignments, keyed by the source Patient's
   * {@link LabeledResource.key} — `'new'` writes it as the person, `{ person }`
   * merges it into an existing one at confirm. A source Patient whose key is
   * not here goes to `'new'`; a key that is not a Patient's is inert.
   */
  readonly patientAssignments: ReadonlyMap<string, PatientIdentity.Target>
}

/** The default selection: every resource included, no edits, every source Patient `'new'`. */
const initial = (): Selection => ({
  excludedResources: new Set(),
  resourceOverrides: new Map(),
  patientAssignments: new Map(),
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

/**
 * Send the source Patient at `sourcePatientKey` to `target` at confirm: a new
 * person (`'new'`), or merged into an existing one.
 */
const assignPatient = (
  selection: Selection,
  sourcePatientKey: string,
  target: PatientIdentity.Target
): Selection => {
  const patientAssignments = new Map(selection.patientAssignments)
  patientAssignments.set(sourcePatientKey, target)
  return { ...selection, patientAssignments }
}

/** Where the source Patient at `sourcePatientKey` goes at confirm — `'new'` unless assigned. */
const patientTarget = (selection: Selection, sourcePatientKey: string): PatientIdentity.Target =>
  selection.patientAssignments.get(sourcePatientKey) ?? 'new'

/** Whether the reviewer has set an inline edit for `key`. */
const isResourceEdited = (selection: Selection, key: string): boolean =>
  selection.resourceOverrides.has(key)

/** The edit override at `key`, when the reviewer has set one — else `None`. */
const editedResource = (selection: Selection, key: string): Option.Option<FhirResource> => {
  const override = selection.resourceOverrides.get(key)
  return override === undefined ? Option.none() : Option.some(override)
}

/** Every labeled resource with its inline edit substituted, whether included or not. */
const reviewedResources = (
  labeled: readonly DecodedFile.Resource[],
  selection: Selection
): readonly DecodedFile.Resource[] =>
  labeled.map((entry) => ({
    ...entry,
    resource: selection.resourceOverrides.get(entry.key) ?? entry.resource,
  }))

/** The merge `entry` asks for: a source Patient the reviewer assigned to an existing person. */
const sourceMergeOf = (
  selection: Selection,
  entry: DecodedFile.Resource
): Option.Option<PatientIdentity.SourceMerge> => {
  const target = patientTarget(selection, entry.key)
  return entry.resource.resourceType === 'Patient' && target !== 'new'
    ? Option.some({ sourcePatient: entry.resource, person: target.person })
    : Option.none()
}

/**
 * Every merge the reviewed entries ask for, in review order — included or not:
 * a merged source Patient is never written either way, and a source Patient the
 * server already holds unchanged starts out excluded.
 */
const sourceMerges = (
  reviewed: readonly DecodedFile.Resource[],
  selection: Selection
): readonly PatientIdentity.SourceMerge[] =>
  reviewed.flatMap((entry) => Option.toArray(sourceMergeOf(selection, entry)))

/**
 * The confirm's write set: every labeled resource the reviewer left included,
 * with any inline edit substituted in, in resolve order — and each source
 * Patient assigned to an existing person merged into it.
 *
 * @param labeled - The labeled resources from the format's `resolve`
 * @param selection - The reviewer's per-resource choices
 * @returns The resources to write, each replaced by its edit override when the
 *   reviewer has set one
 *
 * @remarks
 * Each source Patient assigned to `{ person }`, included or not, is left out
 * and merged into that person (`PatientIdentity.mergeSourcePatients`), which
 * re-points every reference to it. A source Patient assigned `'new'` is
 * written as it is, unless excluded.
 */
const chosenResources = (
  labeled: readonly DecodedFile.Resource[],
  selection: Selection
): readonly FhirResource[] => {
  const reviewed = reviewedResources(labeled, selection)
  const included = reviewed.filter((entry) => isResourceIncluded(selection, entry.key))
  const kept = included
    .filter((entry) => Option.isNone(sourceMergeOf(selection, entry)))
    .map(({ resource }) => resource)
  return PatientIdentity.mergeSourcePatients(kept, sourceMerges(reviewed, selection))
}

/** How many labeled resources are included under a selection. */
const includedCount = (labeled: readonly DecodedFile.Resource[], selection: Selection): number =>
  labeled.filter((entry) => isResourceIncluded(selection, entry.key)).length

/**
 * How many references in the write set name a merged source Patient other than
 * by its relative reference, and so still name it rather than the person.
 */
const referencesNotRewrittenCount = (
  labeled: readonly DecodedFile.Resource[],
  selection: Selection
): number => {
  return PatientIdentity.referencesNotRewrittenCount(
    chosenResources(labeled, selection),
    sourceMerges(reviewedResources(labeled, selection), selection).map(
      ({ sourcePatient }) => sourcePatient
    )
  )
}

/** How many labeled resources are excluded under a selection. */
const excludedCount = (labeled: readonly DecodedFile.Resource[], selection: Selection): number =>
  labeled.filter((entry) => !isResourceIncluded(selection, entry.key)).length

export {
  assignPatient,
  chosenResources,
  edit,
  editedResource,
  excludedCount,
  includedCount,
  initial,
  isResourceEdited,
  isResourceIncluded,
  patientTarget,
  referencesNotRewrittenCount,
  revert,
  setResourcesIncluded,
  toggleResource,
}
export type { Selection }
