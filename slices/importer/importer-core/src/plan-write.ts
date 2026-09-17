import type { FhirResource } from 'fhir-r4/resources'
import { StagedImport, DecodedFile, type FormatDecode } from 'importer-fundamentals'

/**
 * The pure half of the confirm: from one format's decode result and the
 * selection it was reviewed under, exactly the resources to write — or the
 * reason nothing is. The shell submits the `write` plan as one batch
 * bundle; nothing here touches a client.
 *
 * @remarks
 * The write set is the reviewed objects themselves — the exclusions applied
 * and the inline edits substituted — with no re-parse and no rewriting: a
 * format's `decode` already minted its source-file `DocumentReference` and
 * stamped every extracted resource's `meta.source`, so the confirm has no
 * provenance to add. A source-file row the reviewer excluded is simply not
 * written; the resources that name it keep their `meta.source` (the id is
 * deterministic in the file's bytes and name, so a later upload of the same
 * file resolves the link).
 *
 * @packageDocumentation
 */

/**
 * Why a format in a confirmed batch contributes no written resources
 * without that being a failure: `nothing` — the review kept none of its
 * resources (or its decode yielded none); `unreadable` — all its files
 * rejected during decode; `unrecognized` — no format claimed the file.
 */
type SkipReason = 'nothing' | 'unreadable' | 'unrecognized'

/** What one format's confirm should do. */
type WritePlan =
  | { readonly _tag: 'skip'; readonly reason: SkipReason }
  | {
      readonly _tag: 'write'
      /** The resources to submit, in review order, edits substituted. */
      readonly resources: readonly FhirResource[]
      /** How many previewed resources the reviewer opted out. */
      readonly excluded: number
    }

/**
 * Plan one format's write from its reviewed selection.
 *
 * @param result - The format's decode result
 * @param selection - The selection the reviewer left it with
 * @returns A `write` of the chosen resources, or a `skip` with its reason
 */
const planFormatWrite = (
  result: FormatDecode.Result<string>,
  selection: StagedImport.Selection
): WritePlan => {
  const labeled = DecodedFile.resources(result.decoded)
  const resources = StagedImport.chosenResources(labeled, selection)
  if (resources.length === 0) {
    const reason: SkipReason =
      labeled.length === 0 && result.unreadableFiles.length > 0 ? 'unreadable' : 'nothing'
    return { _tag: 'skip', reason }
  }
  return { _tag: 'write', resources, excluded: StagedImport.excludedCount(labeled, selection) }
}

export { planFormatWrite, type SkipReason, type WritePlan }
