import { useQueryClient } from '@tanstack/react-query'
import { Effect, Match } from 'effect'
import { useCallback, useRef, useState } from 'react'

import { useRunAuthed } from 'fhir-r4-react'
import type { FhirR4ResourcesHttpApiClient } from 'fhir-r4/clients'
import type { FhirResource } from 'fhir-r4/resources'
import { type PersistFailure, Review, sectionResources } from 'importer-fundamentals'

import { HAR_ARCHIVES_QUERY_KEY } from '../queries/keys.ts'
import type { BoundFormat, FormatKind } from '../registry.ts'
import {
  type BatchOutcome,
  type FileImportResult,
  importOutcome,
  type SkipReason,
} from '../results/import-outcome.ts'
import type { PickedFile } from '../sources/picked-file.ts'
import type { FileReadOutcome } from './use-import-run.ts'

/**
 * The opt-in write half of the flow, as one imperative action over a
 * batch: for every file with reviewed resources the review kept
 * included, secure a `sourceRef` for the file (its own format's
 * `uploadSource`), then persist those resources through the file's
 * format-specific `persist` — verbatim, each stamped with the archive
 * it came from.
 *
 * @remarks
 * The seam the preview-then-confirm promise rests on — nothing here runs
 * until the user confirms a reviewed batch. Per file the order is
 * load-bearing: secure the archive reference first (a `server` pick
 * already has one; a `local` pick uploads its bytes via the format's
 * `uploadSource`), then persist the review's chosen resources — the
 * same objects the reviewer inspected, no re-parse at confirm. Every
 * step dispatches per-file through the registry, so a HAR file writes
 * via `har-importer-core` and a LifeLabs PDF via
 * `lifelabs-pdf-importer-core`, each stamped with its own source
 * archive `DocumentReference`. Each file's failure is caught into its
 * own `uploadFailed` result, so one file never stops the rest; a file
 * with nothing included is `skipped` and never touches the server.
 *
 * After the batch resolves, the HAR archive list query is invalidated
 * once — so a freshly uploaded HAR appears in `ServerHarArchiveList` on
 * the next pick — even if no HAR file was uploaded; the invalidation
 * is cheap and the alternative (tracking which formats uploaded) buys
 * nothing.
 *
 * @packageDocumentation
 */

/**
 * The lifecycle of one confirmed batch.
 *
 * @remarks
 * `done` carries the whole {@link BatchOutcome} — every file's result — and
 * the results view derives the complete-or-partial framing from it.
 * There is no separate error state: a file's upload failure is a per-file
 * result, not a batch-wide abort, so the flow always resolves to `done`
 * once started.
 */
type ConfirmState =
  | { readonly _tag: 'idle' }
  | { readonly _tag: 'confirming' }
  | { readonly _tag: 'done'; readonly batch: BatchOutcome }

/** How the confirm reads each file's reviewed selection. */
type SelectionFor = (fileId: string) => Review.Selection<FhirResource>

/** Imperative surface the screen drives the confirm through. */
interface ConfirmImport {
  readonly state: ConfirmState
  /**
   * Run the per-file upload-then-persist action for every read file in
   * the batch, dispatching each file through its own format's
   * `uploadSource` + `persist`. Each read file's labeled resources come
   * off its own decoded sections — the same objects the preview rendered.
   */
  readonly confirm: (files: readonly FileReadOutcome[], selectionFor: SelectionFor) => void
  /** Discard the outcome and return to `idle` (a "start over" from results). */
  readonly reset: () => void
}

/** The format lookup this hook needs: the format's own `uploadSource` + `persist`. */
type ConfirmRegistry = {
  readonly [K in FormatKind]: Pick<BoundFormat<K>, 'uploadSource' | 'persist'>
}

/**
 * Upload one local pick's bytes through its format's `uploadSource`,
 * dispatched with `Match.type<FormatKind>()` so `kind` narrows to a
 * specific K per branch. No `as` cast — each branch calls
 * `registry[K].uploadSource(picked)` with a `BoundFormat<K>`-typed value.
 */
const uploadSourceFor = (
  registry: ConfirmRegistry,
  format: FormatKind,
  picked: PickedFile
): Effect.Effect<string, unknown, FhirR4ResourcesHttpApiClient> =>
  Match.type<FormatKind>().pipe(
    Match.when('har', (kind) => registry[kind].uploadSource(picked)),
    Match.when('lifelabs-pdf', (kind) => registry[kind].uploadSource(picked)),
    Match.exhaustive
  )(format)

/**
 * Run one file's chosen resources through its own format's `persist` —
 * dispatched through `Match.type` on `FormatKind` so `kind` narrows to a
 * specific K per branch. Every registered format returns the uniform
 * `PersistFailure[]` shape.
 */
const persistFor = (
  registry: ConfirmRegistry,
  format: FormatKind,
  resources: readonly FhirResource[],
  sourceRef: string
): Effect.Effect<readonly PersistFailure[], never, FhirR4ResourcesHttpApiClient> =>
  Match.type<FormatKind>().pipe(
    Match.when('har', (kind) => registry[kind].persist(resources, sourceRef)),
    Match.when('lifelabs-pdf', (kind) => registry[kind].persist(resources, sourceRef)),
    Match.exhaustive
  )(format)

/**
 * The archive reference a file's resources write against: a `server`
 * pick's own reference, or the reference minted by the format's
 * `uploadSource` for a `local` pick.
 */
const secureSourceRef = (
  registry: ConfirmRegistry,
  format: FormatKind,
  picked: PickedFile
): Effect.Effect<string, unknown, FhirR4ResourcesHttpApiClient> => {
  if (picked.source._tag === 'server') return Effect.succeed(picked.source.reference)
  return uploadSourceFor(registry, format, picked)
}

/**
 * Run one read file to its {@link FileImportResult}: skip a file the
 * review kept nothing from, otherwise secure a source reference and
 * persist its included resources through the file's own format's
 * `persist`. Best-effort — a failed upload is caught into an
 * `uploadFailed` result, never a raised error.
 */
const importOneFile = (
  file: FileReadOutcome,
  registry: ConfirmRegistry,
  selectionFor: SelectionFor
): Effect.Effect<FileImportResult, never, FhirR4ResourcesHttpApiClient> => {
  const { id, picked } = file
  const fileName = picked.fileName
  const skip = (reason: SkipReason): Effect.Effect<FileImportResult> =>
    Effect.succeed({ _tag: 'skipped', id, fileName, reason })
  return Match.value(file).pipe(
    Match.tag('unreadable', () => skip('unreadable')),
    Match.tag('unrecognized', () => skip('unreadable')),
    Match.tag('read', ({ format, decoded }) => {
      const selection = selectionFor(id)
      const labeled = sectionResources(decoded.sections)
      const resources = Review.chosenResources(labeled, selection)
      const excluded = Review.excludedCount(labeled, selection)
      if (resources.length === 0) return skip('nothing')
      return secureSourceRef(registry, format, picked).pipe(
        Effect.flatMap((sourceRef) =>
          persistFor(registry, format, resources, sourceRef).pipe(
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
 * Drives a single confirmed batch — for each file, upload (if
 * applicable) then persist the review's included resources — as one
 * Effect run through `runAuthed`, mapping its per-file lifecycle onto a
 * {@link BatchOutcome}. The authed runner comes from router context via
 * `fhir-r4-react`, so mount this inside the host app's router and
 * `QueryClientProvider`.
 *
 * @param registry - The registered formats' `uploadSource` and `persist`
 *   indexed by kind (typically the whole `formatRegistry`)
 * @returns The confirm surface: its `state`, the `confirm` trigger, and
 *   a `reset` back to `idle`
 */
const useConfirmImport = (registry: ConfirmRegistry): ConfirmImport => {
  const runAuthed = useRunAuthed()
  const queryClient = useQueryClient()
  const [state, setState] = useState<ConfirmState>({ _tag: 'idle' })
  const latest = useRef(0)

  const confirm = useCallback(
    (files: readonly FileReadOutcome[], selectionFor: SelectionFor): void => {
      latest.current += 1
      const ticket = latest.current
      setState({ _tag: 'confirming' })
      const batch = Effect.forEach(files, (file) => importOneFile(file, registry, selectionFor), {
        concurrency: 'unbounded',
      })
      void runAuthed(batch).then((results) => {
        if (latest.current !== ticket) return
        setState({ _tag: 'done', batch: results })
        // Refresh the HAR archive list — a local HAR upload landed a new
        // DocumentReference the picker should see on next pick. Cheap
        // even when no HAR uploaded; alternative is tracking per-format
        // upload counts, which buys nothing.
        void queryClient.invalidateQueries({ queryKey: HAR_ARCHIVES_QUERY_KEY })
      })
    },
    [registry, runAuthed, queryClient]
  )

  const reset = useCallback((): void => {
    latest.current++
    setState({ _tag: 'idle' })
  }, [])

  return { state, confirm, reset }
}

export {
  type ConfirmImport,
  type ConfirmRegistry,
  type ConfirmState,
  type SelectionFor,
  useConfirmImport,
}
