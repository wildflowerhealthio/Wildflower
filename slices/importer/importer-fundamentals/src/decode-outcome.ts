import type { DecodedFile, LabeledResource } from './file-importer-descriptor.ts'
import { chosenEntries, type ChosenEntry, excludedCount, type Selection } from './staged-import.ts'

/**
 * The pure derivation from a single file's decode outcome to the confirm's
 * input: either the resources to write (with their keys and excluded count)
 * or a reason the file was skipped.
 *
 * @remarks
 * This is the seam between "a file was decoded" and "here is what the confirm
 * writes." Both {@link fromSingleFileDecode} consumers — the React hook's
 * `importOneFile` and a planned `planFormatWrite` — need the same fold, so it
 * lives here rather than reimplemented per callsite. The file's decode outcome
 * is accepted structurally (by `_tag`) so this module stays below
 * `importer-react` and names no format-specific type.
 *
 * @packageDocumentation
 */

/**
 * Why a file in a batch contributed no written resources without that being a
 * failure.
 *
 * @remarks
 * `'nothing'` — the file previewed no resources to import (its traffic matched
 * no kind, or matched but decoded nothing). `'unreadable'` — the file did not
 * parse, or no registered descriptor claimed it. Neither is an error; each is
 * reported so a reader knows why a file they picked wrote nothing.
 */
type SkipReason = 'nothing' | 'unreadable'

/**
 * What the confirm sees for one file: either resources to write (with the
 * excluded count for reporting) or a reason to skip it.
 */
type WriteSet<TParsed> =
  | {
      readonly _tag: 'resources'
      readonly chosen: readonly ChosenEntry<TParsed>[]
      readonly excluded: number
    }
  | { readonly _tag: 'skip'; readonly reason: SkipReason }

/**
 * The structural shape of a single file's decode outcome this module accepts.
 * Matches `importer-react`'s `FileReadOutcome` without importing it, so
 * fundamentals stays below the shell.
 */
type SingleFileDecode<TParsed> =
  | {
      readonly _tag: 'read'
      readonly decoded: DecodedFile<TParsed>
    }
  | { readonly _tag: 'unreadable' }
  | { readonly _tag: 'unrecognized' }

const sectionResources = <TParsed>(
  sections: readonly { readonly resources: readonly LabeledResource<TParsed>[] }[]
): readonly LabeledResource<TParsed>[] => sections.flatMap((section) => section.resources)

/**
 * Derive the confirm's write set from a single file's decode outcome and its
 * reviewer selection.
 *
 * @param file - The file's decode outcome, accepted structurally by `_tag`
 * @param selection - The reviewer's per-resource choices for this file
 * @returns `{ _tag: 'resources', chosen, excluded }` when the file decoded and
 *   the reviewer kept at least one resource, or `{ _tag: 'skip', reason }`
 *   when the file was unreadable, unrecognized, or the reviewer excluded
 *   everything
 */
const fromSingleFileDecode = <TParsed>(
  file: SingleFileDecode<TParsed>,
  selection: Selection<TParsed>
): WriteSet<TParsed> => {
  if (file._tag === 'unreadable' || file._tag === 'unrecognized') {
    return { _tag: 'skip', reason: 'unreadable' }
  }
  const labeled = sectionResources(file.decoded.sections)
  const chosen = chosenEntries(labeled, selection)
  const excluded = excludedCount(labeled, selection)
  if (chosen.length === 0) return { _tag: 'skip', reason: 'nothing' }
  return { _tag: 'resources', chosen, excluded }
}

export { fromSingleFileDecode }
export type { SingleFileDecode, SkipReason, WriteSet }
