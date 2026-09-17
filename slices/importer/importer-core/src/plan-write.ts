import { Either, Option } from 'effect'
import type { FhirResource } from 'fhir-r4/resources'
import { StagedImport, sectionResources } from 'importer-fundamentals'

import type { BatchEntry } from './read-batch.ts'

/**
 * The pure half of the confirm: from one unit's read outcome and the
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
 * Why a unit in a confirmed batch contributes no written resources without
 * that being a failure: `nothing` — the review kept none of its resources
 * (or its decode yielded none); `unreadable` — its decode rejected the
 * bytes, or no format claimed it.
 */
type SkipReason = 'nothing' | 'unreadable'

/** What one unit's confirm should do. */
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
 * Plan one unit's write from its reviewed selection.
 *
 * @param unit - The unit's batch entry (an Either)
 * @param selection - The selection the reviewer left it with
 * @returns A `write` of the chosen resources, or a `skip` with its reason
 */
const planUnitWrite = (
  unit: BatchEntry,
  selection: StagedImport.Selection<FhirResource>
): WritePlan =>
  Either.match(unit, {
    onLeft: () => ({ _tag: 'skip', reason: 'unreadable' }),
    onRight: ({ decoded }) => {
      const labeled = sectionResources(decoded.sections)
      const resources = labeled
        .filter((entry) => StagedImport.isResourceIncluded(selection, entry.key))
        .map((entry) =>
          Option.getOrElse(StagedImport.editedResource(selection, entry.key), () => entry.resource)
        )
      if (resources.length === 0) return { _tag: 'skip', reason: 'nothing' }
      return { _tag: 'write', resources, excluded: StagedImport.excludedCount(labeled, selection) }
    },
  })

export { planUnitWrite, type SkipReason, type WritePlan }
