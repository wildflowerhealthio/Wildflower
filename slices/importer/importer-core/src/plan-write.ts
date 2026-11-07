import { type FhirResourceWithId, literalReferenceOf } from '@wildflowerhealthio/fhir-r4/resources'
import { type DecodedFile, Mention, StagedImport } from '@wildflowerhealthio/importer-fundamentals'
import { Array as Arr, Match } from 'effect'

import { type FormatKind, formatKinds } from './registry.ts'
import type { ResolvedBatch } from './resolve-mentions.ts'
import * as ReviewGroup from './review-group.ts'

/**
 * The pure half of the confirm: a decision for every resource the reviewer
 * saw, saying whether it is in the transaction and, when it is not, why. The
 * shell submits the `Included` resources as one transaction bundle and counts
 * the rest; nothing here touches a client.
 *
 * @remarks
 * Each reviewed row first gets a provisional decision, settled or a
 * candidate; the candidates under one `Type/id` are then told apart, and
 * every provisional decision becomes the write decision it settles into.
 *
 * The write set is the reviewed objects themselves — the exclusions applied
 * and the inline edits substituted — with no re-parse and no rewriting: a
 * batch's import stage (`importDecoded`) already minted each source-file
 * `DocumentReference` and stamped every extracted resource's `meta.source`, so
 * the confirm has no provenance to add. A source-file row the reviewer
 * excluded is simply not written; the resources that name it keep their
 * `meta.source` (the id is deterministic in the file's bytes and name, so a
 * later upload of the same file resolves the link).
 *
 * @packageDocumentation
 */

/** Why a reviewed resource is, or is not, in the transaction. */
type Disposition = 'Included' | 'Excluded' | 'Unchanged' | 'Unreferenced' | 'Superseded'

/**
 * One reviewed resource's place in the write: the row as reviewed, edits
 * applied, with its review group and its disposition.
 */
interface WriteDecision extends DecodedFile.Row {
  readonly group: ReviewGroup.Key
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
const skipReasonFor = (group: ReviewGroup.Type): SkipReason =>
  ReviewGroup.rows(group).length === 0 && group.unreadableFiles.length > 0
    ? 'unreadable'
    : 'nothing'

/**
 * How the confirm reads each format's reviewed selection. The linked
 * records' group has none: a linked record is read-only in the review.
 */
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

/**
 * A {@link WriteDecision} before the candidates under one `Type/id` are told
 * apart: the row as reviewed, edits applied, with its review group and its
 * {@link Verdict}.
 */
interface ProvisionalDecision extends DecodedFile.Row {
  readonly group: ReviewGroup.Key
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
 * A provisional decision on a format row: `Unreferenced` when it is a
 * candidate for a record the import implied (its reviewable's `origin`) and
 * no candidate format row names it, which would write it as an orphan; else
 * as it was.
 *
 * @param named - The literal references the candidate format rows carry
 */
const unlessUnreferenced =
  (named: ReadonlySet<string>) =>
  (decision: ProvisionalDecision): ProvisionalDecision =>
    decision.verdict === 'Candidate' &&
    decision.reviewable.origin === 'Implied' &&
    !named.has(literalReferenceOf(decision.resource))
      ? { ...decision, verdict: 'Unreferenced' }
      : decision

/** The order the confirm submits the groups in: the linked records, then the formats in registry order. */
const SUBMIT_ORDER: readonly ReviewGroup.Key[] = [ReviewGroup.LINKED, ...formatKinds]

/**
 * How the rows of one group are provisionally decided: each row as reviewed
 * with its {@link Verdict}.
 */
type ProvisionalDecide = (row: DecodedFile.Row) => Omit<ProvisionalDecision, 'group'>

/**
 * A format row as reviewed: the edit, resolved on the batch's plan,
 * substituted where the reviewer made one
 * (`StagedImport.resolvedResourceOf`), `Excluded` where the row is not
 * included, else a candidate.
 */
const formatDecide =
  (
    batch: ResolvedBatch,
    selection: StagedImport.Selection,
    excludedByDefault: ReadonlySet<string>
  ): ProvisionalDecide =>
  (row) => ({
    ...row,
    resource: StagedImport.resolvedResourceOf(batch.plan, selection, row),
    verdict: StagedImport.isResourceIncluded(selection, excludedByDefault, row.reviewable.key)
      ? 'Candidate'
      : 'Excluded',
  })

/**
 * A linked record as reviewed: `Unchanged` when the server holds it as it
 * is; else a candidate, the link choice being the consent to it.
 *
 * @param unchangedLinked - The keys of the linked records the server diff
 *   found unchanged
 */
const linkedDecide =
  (unchangedLinked: ReadonlySet<string>): ProvisionalDecide =>
  (row) => ({
    ...row,
    verdict: unchangedLinked.has(row.reviewable.key) ? 'Unchanged' : 'Candidate',
  })

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
 * @returns One {@link WriteDecision} per row of every group
 *
 * @remarks
 * The dispositions are decided in this order:
 *
 * - A format row is **`Excluded`** when it is not included: the reviewer
 *   unticked it, or never ticked one the default leaves out. Else it is a
 *   candidate. Its `resource` is the edited resource, resolved on the
 *   batch's plan, where the reviewer made an edit. A record the import
 *   implied from the references naming it (its reviewable's `origin`) is
 *   **`Unreferenced`** when no candidate format row carries its literal
 *   `Type/<id>` in any reference field (`Mention.madeIn`): one nothing
 *   written names would be an orphan.
 * - A linked record is read-only in the review (a link choice is how to
 *   change one), so this is the one place its write is decided. It is
 *   **`Unchanged`** when the server holds it as it is (its reviewable's key in
 *   `unchangedLinked`). Else it — a resolved record no file holds, the
 *   batch's identifiers assumed — is a candidate whatever the reviewer
 *   excluded: the link choice is the consent to it, and excluding a resource
 *   says nothing about who its subject is.
 * - Among the candidates, in submit order, the last under each `Type/id` is
 *   **`Included`** and every earlier one **`Superseded`**. That is the rule
 *   the transaction bundle applies to its entries (last occurrence wins), so
 *   the `Included` resources are exactly the bundle's entries and no row's
 *   edit is lost silently. A record a file decoded wins over one another file
 *   set implied under the same `Type/id`, which says only what a reference
 *   to it said, whatever their order: every implied candidate under it is
 *   `Superseded`. A linked record is a record no resolved file
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
  const decideFor = (group: ReviewGroup.Key): ProvisionalDecide =>
    Match.value(group).pipe(
      Match.when(ReviewGroup.LINKED, () => linkedDecide(unchangedLinked)),
      Match.orElse((kind) => formatDecide(batch, selectionFor(kind), excludedByDefaultFor(kind)))
    )
  const provisional = ReviewGroup.entries(batch.groups, SUBMIT_ORDER).flatMap(([key, group]) => {
    const decide = decideFor(key)
    return ReviewGroup.rows(group).map((row): ProvisionalDecision => ({
      ...decide(row),
      group: key,
    }))
  })
  const named = literalReferencesIn(
    provisional.flatMap(({ group, resource, verdict }) =>
      group !== ReviewGroup.LINKED && verdict === 'Candidate' ? [resource] : []
    )
  )
  const decisions = provisional.map(unlessUnreferenced(named))
  const candidateIndexes = decisions.flatMap(({ reviewable, resource, verdict }, index) =>
    verdict === 'Candidate'
      ? [[literalReferenceOf(resource), index, reviewable.origin] as const]
      : []
  )
  // Built in submit order, implied records first, the map keeps each
  // `Type/id`'s last candidate, a decoded one over any implied one.
  const [decodedCandidates, impliedCandidates] = Arr.partition(
    candidateIndexes,
    ([, , origin]) => origin === 'Implied'
  )
  const lastCandidateIndexByLiteralReference = new Map(
    [...impliedCandidates, ...decodedCandidates].map(
      ([literalReference, index]) => [literalReference, index] as const
    )
  )
  return decisions.map(({ verdict, ...decided }, index): WriteDecision => ({
    ...decided,
    disposition: Match.value(verdict).pipe(
      Match.when('Candidate', (): Disposition =>
        lastCandidateIndexByLiteralReference.get(literalReferenceOf(decided.resource)) === index
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
