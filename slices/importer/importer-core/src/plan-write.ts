import { type FhirResourceWithId, literalReferenceOf } from '@wildflowerhealthio/fhir-r4/resources'
import {
  DecodedFile,
  type FileResolution,
  type FormatDecode,
  Mention,
  StagedImport,
} from '@wildflowerhealthio/importer-fundamentals'
import { Match } from 'effect'

import { claimedFormats } from './read-batch.ts'
import type { FormatKind } from './registry.ts'
import type { ResolvedBatch } from './resolve-mentions.ts'
import { LINKED_GROUP, type ReviewGroup } from './review-group.ts'

/**
 * The pure half of the confirm: a decision for every resource the reviewer
 * saw, saying whether it is in the transaction and, when it is not, why. The
 * shell submits the `Included` resources as one transaction bundle and counts
 * the rest; nothing here touches a client.
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

/** Why a reviewed resource is, or is not, in the transaction. */
type Disposition = 'Included' | 'Excluded' | 'Unchanged' | 'Unreferenced' | 'Superseded'

/** One reviewed resource's place in the write: the row as reviewed, edits applied, and its disposition. */
interface WriteDecision {
  readonly group: ReviewGroup
  readonly entry: DecodedFile.Resource
  readonly disposition: Disposition
}

/**
 * Why a claimed format in a confirmed batch writes nothing without that
 * being a failure: `nothing` — the review kept none of its resources (or its
 * decode yielded none); `unreadable` — all its files rejected during decode.
 */
type SkipReason = 'nothing' | 'unreadable'

/**
 * The reason a claimed format with no `Included` decision writes nothing:
 * `unreadable` when its decode yielded no resources and some file was
 * unreadable, else `nothing`.
 */
const skipReasonFor = (result: FormatDecode.Result<FormatKind>): SkipReason =>
  DecodedFile.resources(result.decoded).length === 0 && result.unreadableFiles.length > 0
    ? 'unreadable'
    : 'nothing'

/** How the confirm reads each format's reviewed selection. */
type SelectionFor = (format: FormatKind) => StagedImport.Selection

/**
 * How the confirm reads which of each format's rows are out unless the
 * reviewer ticked them: the keys the review's default excludes.
 */
type ExcludedByDefaultFor = (format: FormatKind) => ReadonlySet<string>

/**
 * A reviewed resource's disposition before the candidates under one
 * `Type/id` are told apart: settled, or a candidate for the transaction.
 */
type Verdict = Exclude<Disposition, 'Included' | 'Superseded'> | 'Candidate'

/** A reviewed resource with its {@link Verdict}. */
interface ReviewedRow {
  readonly group: ReviewGroup
  readonly entry: DecodedFile.Resource
  readonly verdict: Verdict
}

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
 * Every claimed format's rows, in registry order and then review order, as
 * reviewed: the edit, resolved on the batch's plan, substituted where the
 * reviewer made one (`StagedImport.resolvedResourceOf`), `Excluded` where
 * the row is not included, else a candidate.
 */
const formatRowsOf = (
  batch: ResolvedBatch,
  selectionFor: SelectionFor,
  excludedByDefaultFor: ExcludedByDefaultFor
): readonly ReviewedRow[] =>
  claimedFormats(batch.formats).flatMap((kind) => {
    const selection = selectionFor(kind)
    const excludedByDefault = excludedByDefaultFor(kind)
    return DecodedFile.resources(batch.formats[kind].decoded).map((entry): ReviewedRow => ({
      group: kind,
      entry: { ...entry, resource: StagedImport.resolvedResourceOf(batch.plan, selection, entry) },
      verdict: StagedImport.isResourceIncluded(selection, excludedByDefault, entry.key)
        ? 'Candidate'
        : 'Excluded',
    }))
  })

/**
 * A linked record's verdict: `Unchanged` when the server holds it as it is;
 * else a stored copy is a candidate, the link choice being the consent to
 * it, and a new record a candidate only when a candidate format row names it.
 *
 * @param record - The linked record
 * @param unchangedLinked - The keys of the linked records the server diff
 *   found unchanged
 * @param named - The literal references the candidate format rows carry
 */
const linkedVerdictOf = (
  record: FileResolution.LinkedRecord,
  unchangedLinked: ReadonlySet<string>,
  named: ReadonlySet<string>
): Verdict =>
  unchangedLinked.has(record.key)
    ? 'Unchanged'
    : Match.value(record.origin).pipe(
        Match.when('Stored', (): Verdict => 'Candidate'),
        Match.when('Provisional', (): Verdict =>
          named.has(literalReferenceOf(record.resource)) ? 'Candidate' : 'Unreferenced'
        ),
        Match.exhaustive
      )

/**
 * The confirm's plan: a decision per reviewed resource, in submit order,
 * linked records first, then each claimed format in registry order, rows in
 * review order.
 *
 * @param batch - The resolved batch the reviewer confirmed
 * @param selectionFor - Each format's reviewed selection
 * @param excludedByDefaultFor - Each format's rows out unless the reviewer
 *   ticked them
 * @param unchangedLinked - The keys of the linked records the server diff
 *   found unchanged
 * @returns One {@link WriteDecision} per format row and linked record
 *
 * @remarks
 * The dispositions are decided in this order:
 *
 * - A format row is **`Excluded`** when it is not included: the reviewer
 *   unticked it, or never ticked one the default leaves out. Else it is a
 *   candidate. Its `entry.resource` is the edited resource, resolved on the
 *   batch's plan, where the reviewer made an edit.
 * - A linked record is read-only in the review (a link choice is how to
 *   change one), so this is the one place its write is decided. It is
 *   **`Unchanged`** when the server holds it as it is (its key in
 *   `unchangedLinked`). Else a `Stored` one — a stored resource a link targets
 *   on, the batch's identifiers assumed — is a candidate whatever the
 *   reviewer excluded: the link choice is the consent to it, and excluding a
 *   resource says nothing about who its subject is. A `Provisional` one,
 *   made from a mention alone, is a candidate only when some candidate
 *   format row's resource carries its literal `Type/<id>` in any reference
 *   field (`Mention.madeIn`), else **`Unreferenced`**: one nothing written
 *   names would be an orphan.
 * - Among the candidates, in submit order, the last under each `Type/id` is
 *   **`Included`** and every earlier one **`Superseded`**. That is the rule
 *   the transaction bundle applies to its entries (last occurrence wins), so
 *   the `Included` resources are exactly the bundle's entries and no row's
 *   edit is lost silently. A linked record is a record no resolved file
 *   holds, so it never shares a `Type/id` with a format row.
 *
 * A claimed format with no `Included` decision writes nothing
 * ({@link skipReasonFor}); a batch can so write stored copies and no
 * format's resources. The preview's counts and the confirm read the same
 * plan.
 */
const planWrite = (
  batch: ResolvedBatch,
  selectionFor: SelectionFor,
  excludedByDefaultFor: ExcludedByDefaultFor,
  unchangedLinked: ReadonlySet<string>
): readonly WriteDecision[] => {
  const formatRows = formatRowsOf(batch, selectionFor, excludedByDefaultFor)
  const named = literalReferencesIn(
    formatRows.flatMap(({ entry, verdict }) => (verdict === 'Candidate' ? [entry.resource] : []))
  )
  const rows: readonly ReviewedRow[] = [
    ...batch.linkedRecords.map((record): ReviewedRow => ({
      group: LINKED_GROUP,
      entry: record,
      verdict: linkedVerdictOf(record, unchangedLinked, named),
    })),
    ...formatRows,
  ]
  // Built in submit order, the map keeps each `Type/id`'s last candidate.
  const lastCandidateIndexByLiteralReference = new Map(
    rows.flatMap(({ entry, verdict }, index) =>
      verdict === 'Candidate' ? [[literalReferenceOf(entry.resource), index] as const] : []
    )
  )
  return rows.map(({ group, entry, verdict }, index): WriteDecision => ({
    group,
    entry,
    disposition: Match.value(verdict).pipe(
      Match.when('Candidate', (): Disposition =>
        lastCandidateIndexByLiteralReference.get(literalReferenceOf(entry.resource)) === index
          ? 'Included'
          : 'Superseded'
      ),
      Match.orElse((settled) => settled)
    ),
  }))
}

export {
  type Disposition,
  type ExcludedByDefaultFor,
  planWrite,
  type SelectionFor,
  type SkipReason,
  skipReasonFor,
  type WriteDecision,
}
