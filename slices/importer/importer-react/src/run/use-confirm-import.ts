import { useQueryClient } from '@tanstack/react-query'
import { Array, Effect, Either } from 'effect'
import { useCallback, useRef, useState } from 'react'

import { useRunAuthed } from '@wildflowerhealthio/fhir-r4-react'
import {
  type BatchEntryOutcome,
  type FhirR4ResourcesHttpApiClient,
  persistTransactionBundle,
} from '@wildflowerhealthio/fhir-r4/clients'
import type { FhirResource } from '@wildflowerhealthio/fhir-r4/resources'
import {
  planBatchWrite,
  type ResolvedBatch,
  type SelectionFor,
} from '@wildflowerhealthio/importer-core'

import { LINKED_RECORDS_HEADING } from '../preview/preview-text.ts'
import { SOURCE_FILES_QUERY_KEY, STORED_RESOURCES_QUERY_KEY } from '../queries/keys.ts'
import {
  type BatchOutcome,
  type FileImportResult,
  importOutcome,
  type ResourceResult,
} from '../results/import-outcome.ts'

/**
 * The opt-in write half of the flow, as one imperative action over a batch:
 * the linked records it writes, then every format's resources the review
 * kept included, submitted together as one `persistTransactionBundle`.
 *
 * @remarks
 * Only the formats that claimed a file take part — the same
 * `claimedFormats` set the preview rendered groups for, so the results name
 * exactly the formats the reviewer saw.
 *
 * The seam the preview-then-confirm promise rests on — nothing here runs
 * until the user confirms a reviewed batch, and what runs is
 * `importer-core`'s `planBatchWrite` (the reviewed objects, exclusions
 * applied and edits substituted, no re-parse, and the linked records some
 * written resource names and the server does not hold unchanged) handed to
 * one `POST /` transaction bundle. The source file is one of
 * those reviewed resources — its format's `decode` minted it, listed it in
 * its own "Source file" section, and stamped every extracted resource's
 * `meta.source` with it — so a confirm writes it in the *same* bundle as
 * the resources it names, and this hook adds nothing to any resource. A
 * source-file row the reviewer excluded is simply not written; the
 * resources keep their `meta.source`.
 *
 * One transaction, because the batch is resolved as one: a format's resources
 * point at the linked records and at another format's referents, and a
 * server holding half of that batch would hold references to records it
 * does not. The server lands every entry or none, and
 * `persistTransactionBundle`'s error channel is `never`, so a refusal is
 * every entry's outcome, under the one cause. A format with nothing included
 * is `skipped` and never reaches the bundle.
 *
 * After the transaction resolves, the source-file list query and the stored
 * people and providers the referent rows offer are invalidated once — so a
 * freshly written source file appears in the server list on the next pick,
 * and a person this import wrote is offered to the next — even when the
 * batch wrote none; the invalidation is cheap and the alternative (tracking
 * what the batch wrote) buys nothing.
 *
 * @packageDocumentation
 */

/**
 * The lifecycle of one confirmed batch.
 *
 * @remarks
 * `done` carries the whole {@link BatchOutcome} — every format's result and
 * the linked records' — and the results view derives the complete, partial
 * or failed framing from it. There is no separate error state: a refused
 * transaction is every entry's outcome, not a batch-wide abort, so the flow
 * always resolves to `done` once started.
 */
type ConfirmState =
  | { readonly _tag: 'idle' }
  | { readonly _tag: 'confirming' }
  | { readonly _tag: 'done'; readonly batch: BatchOutcome }

/** Imperative surface the screen drives the confirm through. */
interface ConfirmImport {
  readonly state: ConfirmState
  /**
   * Write the batch as one transaction: the linked records it writes, then
   * each format's reviewed resources. Each format's labeled resources come
   * off its own decoded sections — the same objects the preview rendered,
   * its source file among them. `unchangedLinked` is the keys of the linked
   * records the server diff found unchanged, which are not written.
   */
  readonly confirm: (
    batch: ResolvedBatch,
    selectionFor: SelectionFor,
    unchangedLinked: ReadonlySet<string>
  ) => void
  /** Discard the outcome and return to `idle` (a "start over" from results). */
  readonly reset: () => void
}

/**
 * The transaction's `outcomes` handed back to the units that submitted them,
 * one list per unit of `resourcesPerUnit`, in submit order: the outcomes come
 * back one per resource handed in, at its position, so each unit takes as
 * many as it has resources.
 */
const outcomesPerUnit = (
  outcomes: readonly BatchEntryOutcome[],
  resourcesPerUnit: readonly (readonly FhirResource[])[]
): readonly (readonly BatchEntryOutcome[])[] =>
  Array.mapAccum(resourcesPerUnit, outcomes, (remaining, resources) => {
    const [taken, rest] = Array.splitAt(remaining, resources.length)
    return [rest, taken]
  })[1]

/**
 * Write `batch` as one transaction — the linked records it writes first, then
 * each format's planned write — and fold the outcomes back onto the units
 * they came from: a {@link FileImportResult} per claimed format and
 * unrecognized file, and a {@link ResourceResult} per linked record written.
 */
const importBatch = (
  batch: ResolvedBatch,
  selectionFor: SelectionFor,
  unchangedLinked: ReadonlySet<string>
): Effect.Effect<BatchOutcome, never, FhirR4ResourcesHttpApiClient> => {
  const { formats: planned, linked: linkedWrites } = planBatchWrite(
    batch,
    selectionFor,
    unchangedLinked
  )
  const [skippedFormats, writes] = Array.partitionMap(planned, ({ result, plan }) =>
    plan._tag === 'write'
      ? Either.right({ result, plan })
      : Either.left<FileImportResult>({
          _tag: 'skipped',
          id: result.id,
          title: result.title,
          reason: plan.reason,
        })
  )
  const skipped: readonly FileImportResult[] = [
    ...skippedFormats,
    ...batch.unrecognizedFiles.map((file): FileImportResult => ({
      _tag: 'skipped',
      id: file.id,
      title: file.title,
      reason: 'unrecognized',
    })),
  ]
  const linked = linkedWrites.map((entry) => entry.resource)
  const resourcesPerUnit = [linked, ...writes.map(({ plan }) => plan.resources)]
  return persistTransactionBundle(resourcesPerUnit.flat()).pipe(
    Effect.map((outcomes): BatchOutcome => {
      const [linkedOutcomes = [], ...writeOutcomes] = outcomesPerUnit(outcomes, resourcesPerUnit)
      return {
        linked: linkedOutcomes.map((outcome): ResourceResult => ({
          ...outcome,
          title: LINKED_RECORDS_HEADING,
        })),
        files: [
          ...Array.zipWith(
            writes,
            writeOutcomes,
            ({ result, plan }, unitOutcomes): FileImportResult => ({
              _tag: 'imported',
              id: result.id,
              title: result.title,
              outcome: importOutcome(
                plan.resources.length,
                result.title,
                unitOutcomes,
                plan.excluded
              ),
            })
          ),
          ...skipped,
        ],
      }
    })
  )
}

/**
 * Drives a single confirmed batch — one transaction of the linked records
 * and every format's included resources — as one Effect run through
 * `runAuthed`, mapping its lifecycle onto a {@link BatchOutcome}. The
 * authed runner and the FHIR write client both come from router context via
 * `fhir-r4-react`, so mount this inside the host app's router and
 * `QueryClientProvider`.
 *
 * @returns The confirm surface: its `state`, the `confirm` trigger, and a
 *   `reset` back to `idle`
 */
const useConfirmImport = (): ConfirmImport => {
  const runAuthed = useRunAuthed()
  const queryClient = useQueryClient()
  const [state, setState] = useState<ConfirmState>({ _tag: 'idle' })
  const latest = useRef(0)

  const confirm = useCallback(
    (
      batch: ResolvedBatch,
      selectionFor: SelectionFor,
      unchangedLinked: ReadonlySet<string>
    ): void => {
      latest.current += 1
      const ticket = latest.current
      setState({ _tag: 'confirming' })
      void runAuthed(importBatch(batch, selectionFor, unchangedLinked)).then((outcome) => {
        if (latest.current !== ticket) return
        setState({ _tag: 'done', batch: outcome })
        void queryClient.invalidateQueries({ queryKey: SOURCE_FILES_QUERY_KEY })
        void queryClient.invalidateQueries({ queryKey: STORED_RESOURCES_QUERY_KEY })
      })
    },
    [runAuthed, queryClient]
  )

  const reset = useCallback((): void => {
    latest.current++
    setState({ _tag: 'idle' })
  }, [])

  return { state, confirm, reset }
}

export { type ConfirmImport, type ConfirmState, useConfirmImport }
