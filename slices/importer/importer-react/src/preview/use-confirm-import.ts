import { useQueryClient } from '@tanstack/react-query'
import { Effect, Match, Option } from 'effect'
import { useCallback, useRef, useState } from 'react'

import { useRunAuthed } from 'fhir-r4-react'
import { type FhirR4ResourcesHttpApiClient, persistBatchBundle } from 'fhir-r4/clients'
import type { FhirResource } from 'fhir-r4/resources'
import { StagedImport, sectionResources } from 'importer-fundamentals'
import { withMetaSource } from 'web-trace-core/provenance'

import { SOURCE_FILES_QUERY_KEY } from '../queries/keys.ts'
import {
  type BatchOutcome,
  type FileImportResult,
  importOutcome,
  type SkipReason,
} from '../results/import-outcome.ts'
import { sourceFileReference, type PickedFile } from '../sources/picked-file.ts'
import type { FileReadOutcome } from './use-import-run.ts'

/**
 * The opt-in write half of the flow, as one imperative action over a batch:
 * for every file with reviewed resources the review kept included, submit
 * those resources — including the file's own source file, when the reviewer
 * left it in — as one `persistBatchBundle`, each extracted resource stamped
 * with the source file it came from.
 *
 * @remarks
 * The seam the preview-then-confirm promise rests on — nothing here runs
 * until the user confirms a reviewed batch. The source file is no longer
 * uploaded on its own: it is one of the reviewed resources (its own "Source
 * file" section, minted at read time), so a confirm writes it in the *same*
 * `POST /` batch bundle as the extracted resources — one round trip, not an
 * upload-then-persist. Per file:
 *
 * - Every extracted resource the review kept is stamped with `meta.source =
 *   sourceRef`, the source file's `DocumentReference/<id>`. The source
 *   file's own id is locked to the value it was minted with, so a
 *   reviewer's inline edit (a rename, say) can never drift the link, and
 *   the source file is not stamped onto itself.
 * - `sourceRef` is the server pick's existing reference, or the local pick's
 *   source-file reference when the source file is included. When the reviewer
 *   **skips** the source file (excludes it), there is nothing to point at, so
 *   the extracted resources are written **without** `meta.source`.
 *
 * Each file's write is one `persistBatchBundle`, whose error channel is
 * `never`, so a failed entry (the source file included) is a per-entry
 * result in the batch — one file never stops the rest, and a file with
 * nothing included is `skipped` and never touches the server. There is no
 * separate upload to fail: the source file's write shows up as an ordinary
 * row in the results.
 *
 * After the batch resolves, the source-file list query is invalidated
 * once — so a freshly written source file appears in the server list on the
 * next pick — even when the batch wrote none; the invalidation is cheap and
 * the alternative (tracking which files wrote a source file) buys nothing.
 *
 * @packageDocumentation
 */

/**
 * The lifecycle of one confirmed batch.
 *
 * @remarks
 * `done` carries the whole {@link BatchOutcome} — every file's result — and
 * the results view derives the complete-or-partial framing from it.
 * There is no separate error state: a resource's write failure is a per-entry
 * result, not a batch-wide abort, so the flow always resolves to `done`
 * once started.
 */
type ConfirmState =
  | { readonly _tag: 'idle' }
  | { readonly _tag: 'confirming' }
  | { readonly _tag: 'done'; readonly batch: BatchOutcome }

/** How the confirm reads each file's reviewed selection. */
type SelectionFor = (fileId: string) => StagedImport.Selection<FhirResource>

/** Imperative surface the screen drives the confirm through. */
interface ConfirmImport {
  readonly state: ConfirmState
  /**
   * Run the per-file persist action for every read file in the batch. Each
   * read file's labeled resources come off its own decoded sections — the
   * same objects the preview rendered, including its source file.
   */
  readonly confirm: (files: readonly FileReadOutcome[], selectionFor: SelectionFor) => void
  /** Discard the outcome and return to `idle` (a "start over" from results). */
  readonly reset: () => void
}

/** One chosen resource carried with the review key it was chosen under. */
interface ChosenEntry {
  readonly key: string
  readonly resource: FhirResource
}

/**
 * Every labeled resource the reviewer left included, with any inline edit
 * substituted in, carried alongside its {@link StagedImport.Selection} key — the
 * key form of {@link StagedImport.chosenResources}, so the confirm can tell the
 * file's source file apart from the extracted resources by its stable key
 * rather than by re-recognizing its coding.
 */
const chosenEntries = (
  labeled: readonly { readonly key: string; readonly resource: FhirResource }[],
  selection: StagedImport.Selection<FhirResource>
): readonly ChosenEntry[] =>
  labeled
    .filter((entry) => StagedImport.isResourceIncluded(selection, entry.key))
    .map((entry) => ({
      key: entry.key,
      resource: Option.getOrElse(
        StagedImport.editedResource(selection, entry.key),
        () => entry.resource
      ),
    }))

/** Replace a resource's `id`, preserving its concrete type — mirrors {@link withMetaSource}. */
const withId = <TResource extends { readonly id: string | null }>(
  resource: TResource,
  id: string
): TResource => ({ ...resource, id })

/**
 * The source-file reference a file's extracted resources stamp onto
 * `meta.source`, or `undefined` when there is nothing to point at.
 *
 * @remarks
 * A `server` pick's source file is already on the server, so its own
 * reference is the stamp. A `local` pick's source file rides this batch,
 * so its minted id becomes the reference — but only when the reviewer kept
 * it included; a skipped source file leaves the extracted resources
 * unstamped.
 */
const provenanceRef = (
  picked: PickedFile,
  canonicalId: string | null,
  sourceFileIncluded: boolean
): string | undefined => {
  if (picked.source._tag === 'server') return picked.source.reference
  if (sourceFileIncluded && canonicalId !== null) return sourceFileReference(canonicalId)
  return undefined
}

/**
 * Run one read file to its {@link FileImportResult}: skip a file the review
 * kept nothing from, otherwise submit its included resources as one batch
 * bundle. Best-effort — `persistBatchBundle` never fails, so a rejected
 * resource is a per-entry outcome, never a raised error.
 */
const importOneFile = (
  file: FileReadOutcome,
  selectionFor: SelectionFor
): Effect.Effect<FileImportResult, never, FhirR4ResourcesHttpApiClient> => {
  const { id, picked } = file
  const fileName = picked.fileName
  const skip = (reason: SkipReason): Effect.Effect<FileImportResult> =>
    Effect.succeed({ _tag: 'skipped', id, fileName, reason })
  return Match.value(file).pipe(
    Match.tag('unreadable', () => skip('unreadable')),
    Match.tag('unrecognized', () => skip('unreadable')),
    Match.tag('read', ({ decoded, sourceFile }) => {
      const selection = selectionFor(id)
      const labeled = sectionResources(decoded.sections)
      const chosen = chosenEntries(labeled, selection)
      const excluded = StagedImport.excludedCount(labeled, selection)
      if (chosen.length === 0) return skip('nothing')

      const sourceFileKey = sourceFile?.key
      const canonicalId = sourceFile?.resource.id ?? null
      const sourceFileIncluded =
        sourceFile !== undefined && StagedImport.isResourceIncluded(selection, sourceFile.key)
      const sourceRef = provenanceRef(picked, canonicalId, sourceFileIncluded)

      const resources = chosen.map(({ key, resource }) => {
        if (key === sourceFileKey)
          return canonicalId === null ? resource : withId(resource, canonicalId)
        return sourceRef === undefined ? resource : withMetaSource(resource, sourceRef)
      })

      return persistBatchBundle(resources).pipe(
        Effect.map((entries): FileImportResult => ({
          _tag: 'imported',
          id,
          fileName,
          outcome: importOutcome(resources.length, sourceRef, fileName, entries, excluded),
        }))
      )
    }),
    Match.exhaustive
  )
}

/**
 * Drives a single confirmed batch — for each file, persist the review's
 * included resources (its source file among them, when kept) — as one Effect
 * run through `runAuthed`, mapping its per-file lifecycle onto a
 * {@link BatchOutcome}. The authed runner and the FHIR write client both come
 * from router context via `fhir-r4-react`, so mount this inside the host app's
 * router and `QueryClientProvider`.
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
    (files: readonly FileReadOutcome[], selectionFor: SelectionFor): void => {
      latest.current += 1
      const ticket = latest.current
      setState({ _tag: 'confirming' })
      const batch = Effect.forEach(files, (file) => importOneFile(file, selectionFor), {
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
