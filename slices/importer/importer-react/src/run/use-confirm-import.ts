import { useQueryClient } from '@tanstack/react-query'
import { Effect } from 'effect'
import { useCallback, useRef, useState } from 'react'

import { useRunAuthed } from 'fhir-r4-react'
import { type FhirR4ResourcesHttpApiClient, persistBatchBundle } from 'fhir-r4/clients'
import {
  type BatchDecodeResult,
  claimedFormats,
  type FormatKind,
  planFormatWrite,
} from 'importer-core'
import type { FormatDecode, StagedImport } from 'importer-fundamentals'

import { SOURCE_FILES_QUERY_KEY } from '../queries/keys.ts'
import {
  type BatchOutcome,
  type FileImportResult,
  importOutcome,
} from '../results/import-outcome.ts'

/**
 * The opt-in write half of the flow, as one imperative action over a batch:
 * for every format with reviewed resources the review kept included, submit
 * exactly those resources as one `persistBatchBundle`.
 *
 * @remarks
 * Only the formats that claimed a file take part — the same
 * `claimedFormats` set the preview rendered groups for, so the results name
 * exactly the formats the reviewer saw.
 *
 * The seam the preview-then-confirm promise rests on — nothing here runs
 * until the user confirms a reviewed batch, and what runs is
 * `importer-core`'s `planFormatWrite` (the reviewed objects, exclusions
 * applied and edits substituted, no re-parse) handed to one `POST /` batch
 * bundle per format. The source file is one of those reviewed resources —
 * its format's `decode` minted it, listed it in its own "Source file"
 * section, and stamped every extracted resource's `meta.source` with it —
 * so a confirm writes it in the *same* bundle as the resources it names,
 * and this hook adds nothing to any resource. A source-file row the
 * reviewer excluded is simply not written; the resources keep their
 * `meta.source`.
 *
 * Each format's write is one `persistBatchBundle`, whose error channel is
 * `never`, so a failed entry (the source file included) is a per-entry
 * result in the batch — one format never stops the rest, and a format with
 * nothing included is `skipped` and never touches the server.
 *
 * After the batch resolves, the source-file list query is invalidated
 * once — so a freshly written source file appears in the server list on the
 * next pick — even when the batch wrote none; the invalidation is cheap and
 * the alternative (tracking which formats wrote a source file) buys nothing.
 *
 * @packageDocumentation
 */

/**
 * The lifecycle of one confirmed batch.
 *
 * @remarks
 * `done` carries the whole {@link BatchOutcome} — every format's result —
 * and the results view derives the complete-or-partial framing from it.
 * There is no separate error state: a resource's write failure is a
 * per-entry result, not a batch-wide abort, so the flow always resolves to
 * `done` once started.
 */
type ConfirmState =
  | { readonly _tag: 'idle' }
  | { readonly _tag: 'confirming' }
  | { readonly _tag: 'done'; readonly batch: BatchOutcome }

/** How the confirm reads each format's reviewed selection. */
type SelectionFor = (format: FormatKind) => StagedImport.Selection

/** Imperative surface the screen drives the confirm through. */
interface ConfirmImport {
  readonly state: ConfirmState
  /**
   * Run the per-format persist action for every format in the batch. Each
   * format's labeled resources come off its own decoded sections — the same
   * objects the preview rendered, its source file among them.
   */
  readonly confirm: (batch: BatchDecodeResult, selectionFor: SelectionFor) => void
  /** Discard the outcome and return to `idle` (a "start over" from results). */
  readonly reset: () => void
}

/**
 * Run one format to its {@link FileImportResult}: skip a format the review
 * kept nothing from, otherwise submit its included resources as one batch
 * bundle. Best-effort — `persistBatchBundle` never fails, so a rejected
 * resource is a per-entry outcome, never a raised error.
 */
const importOneFormat = (
  result: FormatDecode.Result<string>,
  selection: StagedImport.Selection
): Effect.Effect<FileImportResult, never, FhirR4ResourcesHttpApiClient> => {
  const { id, title } = result
  const plan = planFormatWrite(result, selection)
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
 * Drives a single confirmed batch — for each format, persist the review's
 * included resources — as one Effect run through `runAuthed`, mapping its
 * per-format lifecycle onto a {@link BatchOutcome}. The authed runner and
 * the FHIR write client both come from router context via `fhir-r4-react`,
 * so mount this inside the host app's router and `QueryClientProvider`.
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
    (batchResult: BatchDecodeResult, selectionFor: SelectionFor): void => {
      latest.current += 1
      const ticket = latest.current
      setState({ _tag: 'confirming' })

      // Only the formats that claimed a file: a format that claimed none has
      // an empty result with a blank title, and planning a write for it would
      // report a titleless "nothing to import" row per unused format.
      const formatEffects = claimedFormats(batchResult).map((kind) =>
        importOneFormat(batchResult[kind], selectionFor(kind))
      )
      const unrecognizedEffects = batchResult.unrecognizedFiles.map(
        (file): Effect.Effect<FileImportResult> =>
          Effect.succeed({
            _tag: 'skipped',
            id: file.id,
            title: file.title,
            reason: 'unrecognized',
          })
      )
      const all = Effect.forEach([...formatEffects, ...unrecognizedEffects], (e) => e, {
        concurrency: 'unbounded',
      })
      void runAuthed(all).then((results) => {
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
