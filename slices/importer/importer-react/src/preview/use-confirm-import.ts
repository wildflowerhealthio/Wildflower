import { Cause, Effect, Match, Runtime } from 'effect'
import { useCallback, useRef, useState } from 'react'

import { useRunAuthed } from 'fhir-r4-react'
import type { FhirR4ResourcesHttpApiClient } from 'fhir-r4/clients'
import { ImportPreview } from 'importer-core'

import { useUploadHar } from '../mutations/upload-har.ts'
import {
  type BatchOutcome,
  type FileImportResult,
  importOutcome,
  previewResourceCount,
  type SkipReason,
} from '../results/import-outcome.ts'
import { harArchiveReference, type PickedHar } from '../sources/picked-har.ts'
import type { FileReadOutcome } from './use-import-run.ts'

/**
 * The opt-in write half of the flow, as one imperative action over a batch:
 * for every file that has resources to write, upload its HAR archive if the pick
 * is local, then persist that file's previewed resources, each stamped with the
 * archive it came from.
 *
 * @remarks
 * This is the seam the preview-then-confirm promise rests on — nothing here runs
 * until the user confirms a batch they have seen. Each file is handled
 * independently and the order within a file is fixed and load-bearing:
 *
 * 1. **Secure provenance.** A `local` pick has bytes the server has never seen,
 *    so its archive is uploaded first (`useUploadHar`, a fresh uuid per the epic
 *    decision) and the reference the upload mints becomes the `meta.source` every
 *    resource from _that file_ carries. A `server` pick already names the archive
 *    it was fetched from, so it skips the upload and links to that document.
 * 2. **Write the resources.** `ImportPreview.persist` runs only after the file's archive
 *    reference exists, so the archive create lands before the first resource write
 *    and no resource ever points at an archive that is not there yet.
 *
 * The whole batch is one Effect run through `runAuthed`: `Effect.forEach` maps
 * each file to a `FileImportResult`, `Match` dispatches the file's kind, and each
 * file's failure is caught into an `uploadFailed` result so one file never stops
 * the rest (the multi-file echo of `ImportPreview.persist` returning per-resource
 * failures as data). Files with nothing to write (recognized by no source,
 * recognized but empty, or unreadable) are `skipped` and never touch the server.
 *
 * @packageDocumentation
 */

/**
 * The lifecycle of one confirmed batch.
 *
 * @remarks
 * `done` carries the whole {@link BatchOutcome} — every file's result — and the
 * results view derives the complete-or-partial framing from it. There is no
 * separate error state: a file's upload failure is a per-file result, not a
 * batch-wide abort, so the flow always resolves to `done` once started.
 */
type ConfirmState =
  | { readonly _tag: 'idle' }
  | { readonly _tag: 'confirming' }
  | { readonly _tag: 'done'; readonly batch: BatchOutcome }

/** Imperative surface the screen drives the confirm through. */
interface ConfirmImport {
  readonly state: ConfirmState
  /** Run the per-file upload-then-persist action for every read file in the batch. */
  readonly confirm: (files: readonly FileReadOutcome[]) => void
  /** Discard the outcome and return to `idle` (a "start over" from results). */
  readonly reset: () => void
}

/**
 * The archive reference a file's resources write against: a `server` pick's own
 * reference, or the reference minted by uploading a `local` pick's bytes.
 *
 * @remarks
 * The upload crosses a TanStack mutation, so its rejection is a `FiberFailure`
 * that hides the real error behind a summary. `Cause.squash` unwraps it back to
 * the typed failure the FHIR client raised — a `ResponseError` or a `ParseError`
 * — so {@link importOneFile}'s catch keeps something the results view can render
 * in full rather than a flattened one-liner. A `local` pick's bytes are encoded
 * from its text here: the upload takes bytes, not text, so the stored archive is
 * verbatim and its attachment hash means something.
 */
const secureSourceRef = (
  picked: PickedHar,
  uploadHar: ReturnType<typeof useUploadHar>
): Effect.Effect<string, unknown> => {
  if (picked.source._tag === 'server') return Effect.succeed(picked.source.reference)
  return Effect.tryPromise({
    try: () =>
      uploadHar.mutateAsync({
        fileName: picked.fileName,
        bytes: new TextEncoder().encode(picked.text),
      }),
    catch: (error) =>
      Runtime.isFiberFailure(error) ? Cause.squash(error[Runtime.FiberFailureCauseId]) : error,
  }).pipe(Effect.map(harArchiveReference))
}

/**
 * Run one read file to its {@link FileImportResult}: skip a file with nothing to
 * write, otherwise upload its archive and persist its resources. Best-effort — a
 * failed upload is caught into an `uploadFailed` result, never a raised error.
 */
const importOneFile = (
  file: FileReadOutcome,
  uploadHar: ReturnType<typeof useUploadHar>
): Effect.Effect<FileImportResult, never, FhirR4ResourcesHttpApiClient> => {
  const { id, picked } = file
  const fileName = picked.fileName
  const skip = (reason: SkipReason): Effect.Effect<FileImportResult> =>
    Effect.succeed({ _tag: 'skipped', id, fileName, reason })
  const write = (
    preview: ImportPreview.Preview
  ): Effect.Effect<FileImportResult, never, FhirR4ResourcesHttpApiClient> =>
    secureSourceRef(picked, uploadHar).pipe(
      Effect.flatMap((sourceRef) =>
        ImportPreview.persist(preview, sourceRef).pipe(
          Effect.map((failures): FileImportResult => ({
            _tag: 'imported',
            id,
            fileName,
            outcome: importOutcome(preview, sourceRef, failures),
          }))
        )
      ),
      Effect.catchAll((error) =>
        Effect.succeed<FileImportResult>({ _tag: 'uploadFailed', id, fileName, error })
      )
    )
  return Match.value(file).pipe(
    Match.tag('unreadable', () => skip('unreadable')),
    // A preview is one shape now — recognition is per-URL, so "nothing
    // recognized" and "recognized but decoded nothing" are one empty preview.
    Match.tag('read', ({ preview }) =>
      previewResourceCount(preview) === 0 ? skip('nothing') : write(preview)
    ),
    Match.exhaustive
  )
}

/**
 * Drives a single confirmed batch — for each file, upload (if local) then
 * persist — as one Effect run through `runAuthed`, mapping its per-file lifecycle
 * onto a {@link BatchOutcome}. The authed runner and the upload mutation both come
 * from router context via `fhir-r4-react`, so mount this inside the host app's
 * router and `QueryClientProvider`.
 *
 * @returns The confirm surface: its `state`, the `confirm` trigger, and a `reset`
 *   back to `idle`
 */
const useConfirmImport = (): ConfirmImport => {
  const runAuthed = useRunAuthed()
  const uploadHar = useUploadHar()
  const [state, setState] = useState<ConfirmState>({ _tag: 'idle' })
  // Ignore a resolution from a confirm the screen has since reset — a stale
  // upload/persist must not overwrite a fresh `idle`.
  const latest = useRef(0)

  const confirm = useCallback(
    (files: readonly FileReadOutcome[]): void => {
      latest.current += 1
      const ticket = latest.current
      setState({ _tag: 'confirming' })
      const batch = Effect.forEach(files, (file) => importOneFile(file, uploadHar), {
        concurrency: 'unbounded',
      })
      void runAuthed(batch).then((results) => {
        if (latest.current !== ticket) return
        setState({ _tag: 'done', batch: results })
      })
    },
    [runAuthed, uploadHar]
  )

  const reset = useCallback((): void => {
    latest.current++
    setState({ _tag: 'idle' })
  }, [])

  return { state, confirm, reset }
}

export { type ConfirmImport, type ConfirmState, useConfirmImport }
