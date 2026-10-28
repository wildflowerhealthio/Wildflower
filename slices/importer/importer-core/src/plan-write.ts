import type { FhirResourceWithId } from '@wildflowerhealthio/fhir-r4/resources'
import {
  StagedImport,
  DecodedFile,
  type FormatDecode,
  Mention,
} from '@wildflowerhealthio/importer-fundamentals'

import { claimedFormats } from './read-batch.ts'
import type { FormatKind } from './registry.ts'
import type { ResolvedBatch } from './resolve-mentions.ts'

/**
 * The pure half of the confirm: from one format's decode result and the
 * selection it was reviewed under, exactly the resources to write — or the
 * reason nothing is — and, over a whole resolved batch, which of its linked
 * records are written beside them. The shell submits the batch's plan as one
 * transaction bundle; nothing here touches a client.
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
 * rejected during decode.
 */
type SkipReason = 'nothing' | 'unreadable'

/** What one format's confirm should do. */
type WritePlan =
  | { readonly _tag: 'skip'; readonly reason: SkipReason }
  | {
      readonly _tag: 'write'
      /** The resources to submit, in review order, edits substituted. */
      readonly resources: readonly FhirResourceWithId[]
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

/** One claimed format's decode result with the write its review planned. */
interface PlannedFormat {
  readonly result: FormatDecode.Result<FormatKind>
  readonly plan: WritePlan
}

/** What a confirm of a whole resolved batch writes. */
interface BatchWritePlan {
  /** Every claimed format's plan, in registry order. */
  readonly formats: readonly PlannedFormat[]
  /** The linked records written beside the formats' resources, in discovery order. */
  readonly linked: readonly DecodedFile.Resource[]
}

/** How the confirm reads each format's reviewed selection. */
type SelectionFor = (format: FormatKind) => StagedImport.Selection

/** Every literal reference `resources` carry, in any reference field. */
const literalReferencesIn = (resources: readonly FhirResourceWithId[]): ReadonlySet<string> =>
  new Set(
    resources.flatMap((resource) =>
      Mention.madeIn(resource).flatMap(({ reference }) =>
        reference.reference === null ? [] : [reference.reference]
      )
    )
  )

/**
 * Plan the write of a whole resolved batch: each claimed format's write from
 * its reviewed selection, and the linked records written beside them.
 *
 * @param batch - The resolved batch the reviewer confirmed
 * @param selectionFor - Each format's reviewed selection
 * @param unchangedLinked - The keys of the linked records the server diff
 *   found unchanged
 * @returns Every claimed format's plan and the linked records to write
 *
 * @remarks
 * The linked records are read-only in the review (a link choice is how to
 * change one), so which of them is written is decided here, and only here.
 * None the server already holds as it is (its key in `unchangedLinked`) is
 * written: that would be a rewrite of itself. Otherwise:
 *
 * - A **stored copy** — a linked record of `Stored` origin, a stored resource
 *   a link lands on having assumed the batch's identifiers — is written whatever the
 *   reviewer excluded. The link choice is the consent to it; excluding a
 *   resource says nothing about who its subject is. So a batch can write
 *   stored copies and no format's resources.
 * - A **new** record — one of `Provisional` origin, made from a mention alone — is
 *   written only when some resource a format writes references it, by its
 *   literal `Type/<id>` in any reference field: one nothing written names
 *   would be an orphan.
 *
 * The preview's count and the confirm read the same plan.
 */
const planBatchWrite = (
  batch: ResolvedBatch,
  selectionFor: SelectionFor,
  unchangedLinked: ReadonlySet<string>
): BatchWritePlan => {
  const formats = claimedFormats(batch.formats).map((kind): PlannedFormat => ({
    result: batch.formats[kind],
    plan: planFormatWrite(batch.formats[kind], selectionFor(kind)),
  }))
  const referenced = literalReferencesIn(
    formats.flatMap(({ plan }) => (plan._tag === 'write' ? plan.resources : []))
  )
  const linked = batch.linkedRecords.filter(({ key, resource, origin }) => {
    if (unchangedLinked.has(key)) return false
    return origin === 'Stored' || referenced.has(`${resource.resourceType}/${resource.id}`)
  })
  return { formats, linked }
}

export {
  type BatchWritePlan,
  planBatchWrite,
  type PlannedFormat,
  planFormatWrite,
  type SelectionFor,
  type SkipReason,
  type WritePlan,
}
