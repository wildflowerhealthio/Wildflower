import { Cause, Effect, Match, Runtime } from 'effect'
import { useCallback, useRef, useState } from 'react'

import { useRunAuthed } from 'fhir-r4-react'
import type { FhirR4ResourcesHttpApiClient } from 'fhir-r4/clients'
import type { FhirResource } from 'fhir-r4/resources'
import { type LabeledResource, type PersistFailure, Review } from 'importer-fundamentals'

import { useUploadHar } from '../mutations/upload-har.ts'
import type { BoundFormat, FormatKind } from '../registry.tsx'
import {
  type BatchOutcome,
  type FileImportResult,
  importOutcome,
  type SkipReason,
} from '../results/import-outcome.ts'
import { harArchiveReference, type PickedFile } from '../sources/picked-file.ts'
import type { FileReadOutcome } from './use-import-run.ts'

/**
 * The opt-in write half of the flow, as one imperative action over a batch:
 * for every file with reviewed resources the review kept included, secure a
 * `sourceRef` for the file, then persist those resources through the file's
 * format-specific `persist` — verbatim, each stamped with the archive it
 * came from.
 *
 * @remarks
 * The seam the preview-then-confirm promise rests on — nothing here runs
 * until the user confirms a reviewed batch. Per file the order is
 * load-bearing: secure the archive reference first (a `local` HAR uploads
 * its bytes; a `server` HAR already has one; a LifeLabs PDF is not yet
 * writable — the PR that fixes the file-type assumption stops short of a
 * PDF-archive upload codec), then persist the review's chosen resources —
 * the same objects the reviewer inspected, no re-parse at confirm. Each
 * file's failure is caught into its own `uploadFailed` result, so one file
 * never stops the rest; a file with nothing included is `skipped` and
 * never touches the server.
 *
 * @packageDocumentation
 */

/**
 * The lifecycle of one confirmed batch.
 *
 * @remarks
 * `done` carries the whole {@link BatchOutcome} — every file's result — and
 * the results view derives the complete-or-partial framing from it. There
 * is no separate error state: a file's upload failure is a per-file
 * result, not a batch-wide abort, so the flow always resolves to `done`
 * once started.
 */
type ConfirmState =
  | { readonly _tag: 'idle' }
  | { readonly _tag: 'confirming' }
  | { readonly _tag: 'done'; readonly batch: BatchOutcome }

/** How the confirm reads each file's reviewed selection. */
type SelectionFor = (fileId: string) => Review.Selection<FhirResource>

/** How the confirm reads each file's resolved labeled resources. */
type LabeledFor = (fileId: string) => readonly LabeledResource<FhirResource>[]

/** Imperative surface the screen drives the confirm through. */
interface ConfirmImport {
  readonly state: ConfirmState
  /**
   * Run the per-file upload-then-persist action for every read file in the
   * batch, dispatching each file through its own format's `persist`.
   */
  readonly confirm: (
    files: readonly FileReadOutcome[],
    labeledFor: LabeledFor,
    selectionFor: SelectionFor
  ) => void
  /** Discard the outcome and return to `idle` (a "start over" from results). */
  readonly reset: () => void
}

/** The format lookup this hook needs: `persist` per registered format. */
type PersistRegistry = {
  readonly [K in FormatKind]: Pick<BoundFormat<K>, 'persist'>
}

/**
 * A uniform per-format `persist` signature — every registered format
 * produces `FhirResource` and writes through the FHIR client, so any
 * `BoundFormat<K>['persist']` collapses to this shape.
 */
type UniformPersist = (
  resources: readonly FhirResource[],
  sourceRef: string
) => Effect.Effect<readonly PersistFailure[], never, FhirR4ResourcesHttpApiClient>

/** Look up a file's format's `persist` from the registry as a uniform callable. */
const persistOf = (persistRegistry: PersistRegistry, format: FormatKind): UniformPersist =>
  persistRegistry[format].persist

/**
 * The archive reference a file's resources write against: a `server` pick's
 * own reference, the reference minted by uploading a `local` HAR pick's
 * bytes, or a failure for a `local` LifeLabs PDF pick — until the PDF
 * archive codec lands there is nowhere to upload the source PDF.
 *
 * @remarks
 * The upload crosses a TanStack mutation, so its rejection is a
 * `FiberFailure` that hides the real error behind a summary. `Cause.squash`
 * unwraps it back to the typed failure the FHIR client raised. The bytes
 * are passed to the upload verbatim — a `PickedFile` already carries them,
 * no re-encode.
 */
const secureSourceRef = (
  picked: PickedFile,
  format: FormatKind,
  uploadHar: ReturnType<typeof useUploadHar>
): Effect.Effect<string, unknown> => {
  if (picked.source._tag === 'server') return Effect.succeed(picked.source.reference)
  if (format !== 'har') {
    return Effect.fail(
      new Error(
        `Uploading a ${format} pick as an archive DocumentReference is not yet supported. Preview only.`
      )
    )
  }
  return Effect.tryPromise({
    try: () =>
      uploadHar.mutateAsync({
        fileName: picked.fileName,
        bytes: picked.bytes,
      }),
    catch: (error) =>
      Runtime.isFiberFailure(error) ? Cause.squash(error[Runtime.FiberFailureCauseId]) : error,
  }).pipe(Effect.map(harArchiveReference))
}

/**
 * Run one read file to its {@link FileImportResult}: skip a file the review
 * kept nothing from, otherwise secure a source reference and persist its
 * included resources through the file's own format's `persist`. Best-effort
 * — a failed upload is caught into an `uploadFailed` result, never a raised
 * error.
 */
const importOneFile = (
  file: FileReadOutcome,
  persistRegistry: PersistRegistry,
  labeledFor: LabeledFor,
  selectionFor: SelectionFor,
  uploadHar: ReturnType<typeof useUploadHar>
): Effect.Effect<FileImportResult, never, FhirR4ResourcesHttpApiClient> => {
  const { id, picked } = file
  const fileName = picked.fileName
  const skip = (reason: SkipReason): Effect.Effect<FileImportResult> =>
    Effect.succeed({ _tag: 'skipped', id, fileName, reason })
  return Match.value(file).pipe(
    Match.tag('unreadable', () => skip('unreadable')),
    Match.tag('unrecognized', () => skip('unreadable')),
    Match.tag('read', ({ format }) => {
      const selection = selectionFor(id)
      const labeled = labeledFor(id)
      const resources = Review.chosenResources(labeled, selection)
      const excluded = Review.excludedCount(labeled, selection)
      if (resources.length === 0) return skip('nothing')
      // Per-format persist through the registry — a HAR file writes through
      // `har-importer-core`'s FHIR sink, a LifeLabs one through
      // `lifelabs-pdf-importer-core`'s. Both stamp `meta.source` themselves.
      // Both write FHIR resources through the FHIR client, so the signature
      // is uniform across formats; the switch is `format === K` matching so
      // the union of BoundFormat<K> collapses to a callable.
      const persist = persistOf(persistRegistry, format)
      return secureSourceRef(picked, format, uploadHar).pipe(
        Effect.flatMap((sourceRef) =>
          persist(resources, sourceRef).pipe(
            Effect.map((failures): FileImportResult => ({
              _tag: 'imported',
              id,
              fileName,
              outcome: importOutcome(resources.length, sourceRef, failures, excluded),
            }))
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
 * Drives a single confirmed batch — for each file, upload (if applicable)
 * then persist the review's included resources — as one Effect run through
 * `runAuthed`, mapping its per-file lifecycle onto a {@link BatchOutcome}.
 * The authed runner and the HAR upload mutation both come from router
 * context via `fhir-r4-react`, so mount this inside the host app's router
 * and `QueryClientProvider`.
 *
 * @param persistRegistry - The registered formats' `persist` sinks indexed
 *   by format kind
 * @returns The confirm surface: its `state`, the `confirm` trigger, and a
 *   `reset` back to `idle`
 */
const useConfirmImport = (persistRegistry: PersistRegistry): ConfirmImport => {
  const runAuthed = useRunAuthed()
  const uploadHar = useUploadHar()
  const [state, setState] = useState<ConfirmState>({ _tag: 'idle' })
  const latest = useRef(0)

  const confirm = useCallback(
    (
      files: readonly FileReadOutcome[],
      labeledFor: LabeledFor,
      selectionFor: SelectionFor
    ): void => {
      latest.current += 1
      const ticket = latest.current
      setState({ _tag: 'confirming' })
      const batch = Effect.forEach(
        files,
        (file) => importOneFile(file, persistRegistry, labeledFor, selectionFor, uploadHar),
        { concurrency: 'unbounded' }
      )
      void runAuthed(batch).then((results) => {
        if (latest.current !== ticket) return
        setState({ _tag: 'done', batch: results })
      })
    },
    [persistRegistry, runAuthed, uploadHar]
  )

  const reset = useCallback((): void => {
    latest.current++
    setState({ _tag: 'idle' })
  }, [])

  return { state, confirm, reset }
}

export {
  type ConfirmImport,
  type ConfirmState,
  type LabeledFor,
  type PersistRegistry,
  type SelectionFor,
  useConfirmImport,
}
