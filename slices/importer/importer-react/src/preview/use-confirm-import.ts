import { Cause, Effect, Match, Runtime } from 'effect'
import { useCallback, useRef, useState } from 'react'

import { useRunAuthed } from 'fhir-r4-react'
import type { FhirR4ResourcesHttpApiClient } from 'fhir-r4/clients'
import { type FileImporterDescriptor, Review } from 'importer-fundamentals'

import { useUploadHar } from '../mutations/upload-har.ts'
import {
  type BatchOutcome,
  type FileImportResult,
  importOutcome,
  type SkipReason,
} from '../results/import-outcome.ts'
import { harArchiveReference, type PickedHar } from '../sources/picked-har.ts'
import type { FileReadOutcome } from './use-import-run.ts'

/**
 * The opt-in write half of the flow, as one imperative action over a batch:
 * for every file with responses the review chose, upload its HAR archive if the
 * pick is local, then decode and persist those chosen responses, each stamped
 * with the archive it came from.
 *
 * @remarks
 * The seam the preview-then-confirm promise rests on — nothing here runs until
 * the user confirms a reviewed batch. Per file the order is load-bearing:
 * secure the archive reference first (upload a `local` pick's bytes; a `server`
 * pick already has one), then decode and persist **only the chosen responses**
 * (`Review.chosen`) — so no resource ever points at an archive that is not
 * there yet, and the confirm writes exactly what the user opted into. Each
 * file's failure is caught into its own `uploadFailed` result, so one file
 * never stops the rest; a file with nothing chosen is `skipped` and never
 * touches the server.
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

/** How the confirm reads each file's reviewed selection. */
type SelectionFor = (fileId: string) => Review.Selection

/** Imperative surface the screen drives the confirm through. */
interface ConfirmImport {
  readonly state: ConfirmState
  /** Run the per-file upload-then-persist action for every read file in the batch. */
  readonly confirm: (files: readonly FileReadOutcome[], selectionFor: SelectionFor) => void
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
 * Run one read file to its {@link FileImportResult}: skip a file the review chose
 * nothing from, otherwise upload its archive and persist its chosen resources.
 * Best-effort — a failed upload is caught into an `uploadFailed` result, never a
 * raised error.
 */
const importOneFile = <TSettings, TParsed>(
  file: FileReadOutcome,
  descriptor: FileImporterDescriptor<TSettings, TParsed, FhirR4ResourcesHttpApiClient>,
  selectionFor: SelectionFor,
  uploadHar: ReturnType<typeof useUploadHar>
): Effect.Effect<FileImportResult, never, FhirR4ResourcesHttpApiClient> => {
  const { id, picked } = file
  const fileName = picked.fileName
  const skip = (reason: SkipReason): Effect.Effect<FileImportResult> =>
    Effect.succeed({ _tag: 'skipped', id, fileName, reason })
  return Match.value(file).pipe(
    Match.tag('unreadable', () => skip('unreadable')),
    Match.tag('read', ({ responses }) => {
      const selection = selectionFor(id)
      const recognized = Review.recognize(descriptor.pool, responses)
      if (Review.chosenCount(recognized, selection) === 0) return skip('nothing')
      return Review.chosen(descriptor.pool, responses, selection).pipe(
        Effect.flatMap(({ resources }) =>
          secureSourceRef(picked, uploadHar).pipe(
            Effect.flatMap((sourceRef) =>
              descriptor.persist(resources, sourceRef).pipe(
                Effect.map((failures): FileImportResult => ({
                  _tag: 'imported',
                  id,
                  fileName,
                  outcome: importOutcome(resources.length, sourceRef, failures),
                }))
              )
            )
          )
        ),
        Effect.catchAll((error) =>
          Effect.succeed<FileImportResult>({ _tag: 'uploadFailed', id, fileName, error })
        )
      )
    }),
    Match.exhaustive
  )
}

/**
 * Drives a single confirmed batch — for each file, upload (if local) then decode
 * and persist the chosen responses — as one Effect run through `runAuthed`,
 * mapping its per-file lifecycle onto a {@link BatchOutcome}. The authed runner
 * and the upload mutation both come from router context via `fhir-r4-react`, so
 * mount this inside the host app's router and `QueryClientProvider`.
 *
 * @param descriptor - The file format's descriptor (its `pool` + `persist`)
 * @returns The confirm surface: its `state`, the `confirm` trigger, and a `reset`
 *   back to `idle`
 */
const useConfirmImport = <TSettings, TParsed>(
  descriptor: FileImporterDescriptor<TSettings, TParsed, FhirR4ResourcesHttpApiClient>
): ConfirmImport => {
  const runAuthed = useRunAuthed()
  const uploadHar = useUploadHar()
  const [state, setState] = useState<ConfirmState>({ _tag: 'idle' })
  // Ignore a resolution from a confirm the screen has since reset — a stale
  // upload/persist must not overwrite a fresh `idle`.
  const latest = useRef(0)

  const confirm = useCallback(
    (files: readonly FileReadOutcome[], selectionFor: SelectionFor): void => {
      latest.current += 1
      const ticket = latest.current
      setState({ _tag: 'confirming' })
      const batch = Effect.forEach(
        files,
        (file) => importOneFile(file, descriptor, selectionFor, uploadHar),
        { concurrency: 'unbounded' }
      )
      void runAuthed(batch).then((results) => {
        if (latest.current !== ticket) return
        setState({ _tag: 'done', batch: results })
      })
    },
    [descriptor, runAuthed, uploadHar]
  )

  const reset = useCallback((): void => {
    latest.current++
    setState({ _tag: 'idle' })
  }, [])

  return { state, confirm, reset }
}

export { type ConfirmImport, type ConfirmState, type SelectionFor, useConfirmImport }
