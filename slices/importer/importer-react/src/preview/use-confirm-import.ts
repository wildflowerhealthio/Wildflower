import { useQueryClient } from '@tanstack/react-query'
import { Effect } from 'effect'
import { useCallback, useRef, useState } from 'react'

import { useRunAuthed } from 'fhir-r4-react'
import { type FhirR4ResourcesHttpApiClient, persistBatchBundle } from 'fhir-r4/clients'
import type { FhirResource } from 'fhir-r4/resources'
import { planUnitWrite, type UnitReadOutcome } from 'importer-core'
import type { StagedImport } from 'importer-fundamentals'

import { SOURCE_FILES_QUERY_KEY } from '../queries/keys.ts'
import {
  type BatchOutcome,
  type FileImportResult,
  importOutcome,
} from '../results/import-outcome.ts'

/**
 * The opt-in write half of the flow, as one imperative action over a batch:
 * for every unit with reviewed resources the review kept included, submit
 * exactly those resources as one `persistBatchBundle`.
 *
 * @remarks
 * The seam the preview-then-confirm promise rests on — nothing here runs
 * until the user confirms a reviewed batch, and what runs is
 * `importer-core`'s `planUnitWrite` (the reviewed objects, exclusions
 * applied and edits substituted, no re-parse) handed to one `POST /` batch
 * bundle per unit. The source file is one of those reviewed resources — its
 * format's `decode` minted it, listed it in its own "Source file" section,
 * and stamped every extracted resource's `meta.source` with it — so a
 * confirm writes it in the *same* bundle as the resources it names, and
 * this hook adds nothing to any resource. A source-file row the reviewer
 * excluded is simply not written; the resources keep their `meta.source`.
 *
 * - Every extracted resource the review kept is stamped with
 *   `meta.source = sourceRef`, the source file's `DocumentReference/<id>`. The
 *   source file's own id is locked to the value it was minted with, so a
 *   reviewer's inline edit (a rename, say) can never drift the link, and
 *   the source file is not stamped onto itself.
 * - `sourceRef` is the server pick's existing reference, or the local pick's
 *   source-file reference when the source file is included. When the reviewer
 *   **skips** the source file (excludes it), there is nothing to point at, so
 *   the extracted resources are written **without** `meta.source`.
 *
 * Each file's write is one `persistBatchBundle`, whose error channel is
 * `never`, so a failed entry (the source file included) is a per-entry
 * result in the batch — one unit never stops the rest, and a unit with
 * nothing included is `skipped` and never touches the server.
 *
 * After the batch resolves, the source-file list query is invalidated
 * once — so a freshly written source file appears in the server list on the
 * next pick — even when the batch wrote none; the invalidation is cheap and
 * the alternative (tracking which units wrote a source file) buys nothing.
 *
 * @packageDocumentation
 */

/**
 * The lifecycle of one confirmed batch.
 *
 * @remarks
 * `done` carries the whole {@link BatchOutcome} — every unit's result — and
 * the results view derives the complete-or-partial framing from it.
 * There is no separate error state: a resource's write failure is a per-entry
 * result, not a batch-wide abort, so the flow always resolves to `done`
 * once started.
 */
type ConfirmState =
  | { readonly _tag: 'idle' }
  | { readonly _tag: 'confirming' }
  | { readonly _tag: 'done'; readonly batch: BatchOutcome }

/** How the confirm reads each unit's reviewed selection. */
type SelectionFor = (unitId: string) => StagedImport.Selection<FhirResource>

/** Imperative surface the screen drives the confirm through. */
interface ConfirmImport {
  readonly state: ConfirmState
  /**
   * Run the per-unit persist action for every read unit in the batch. Each
   * unit's labeled resources come off its own decoded sections — the same
   * objects the preview rendered, its source file among them.
   */
  readonly confirm: (units: readonly UnitReadOutcome[], selectionFor: SelectionFor) => void
  /** Discard the outcome and return to `idle` (a "start over" from results). */
  readonly reset: () => void
}

/**
 * Run one unit to its {@link FileImportResult}: skip a unit the review kept
 * nothing from, otherwise submit its included resources as one batch
 * bundle. Best-effort — `persistBatchBundle` never fails, so a rejected
 * resource is a per-entry outcome, never a raised error.
 */
const importOneUnit = (
  unit: UnitReadOutcome,
  selectionFor: SelectionFor
): Effect.Effect<FileImportResult, never, FhirR4ResourcesHttpApiClient> => {
  const { id, title } = unit
  const plan = planUnitWrite(unit, selectionFor(id))
  if (plan._tag === 'skip')
    return Effect.succeed({ _tag: 'skipped', id, title, reason: plan.reason })
  return persistBatchBundle(plan.resources).pipe(
    Effect.map((entries): FileImportResult => ({
      _tag: 'imported',
      id,
      title,
      outcome: importOutcome(plan.resources.length, title, entries, plan.excluded),
    }))
  )
}

/**
 * Drives a single confirmed batch — for each unit, persist the review's
 * included resources — as one Effect run through `runAuthed`, mapping its
 * per-unit lifecycle onto a {@link BatchOutcome}. The authed runner and the
 * FHIR write client both come from router context via `fhir-r4-react`, so
 * mount this inside the host app's router and `QueryClientProvider`.
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
    (units: readonly UnitReadOutcome[], selectionFor: SelectionFor): void => {
      latest.current += 1
      const ticket = latest.current
      setState({ _tag: 'confirming' })
      const batch = Effect.forEach(units, (unit) => importOneUnit(unit, selectionFor), {
        concurrency: 'unbounded',
      })
      void runAuthed(batch).then((results) => {
        if (latest.current !== ticket) return
        setState({ _tag: 'done', batch: results })
        void queryClient.invalidateQueries({ queryKey: SOURCE_FILES_QUERY_KEY })
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

export { type ConfirmImport, type ConfirmState, type SelectionFor, useConfirmImport }
