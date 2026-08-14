import { useCallback, useRef, useState } from 'react'

import { useRunAuthed } from 'fhir-r4-react'
import { persistPreview, type Preview } from 'importer-core'

import { useUploadHar } from '../mutations/upload-har.ts'
import { importOutcome, type ImportOutcome, isPartialOutcome } from '../results/import-outcome.ts'
import { harArchiveReference, type PickedHar } from '../sources/picked-har.ts'

/**
 * The opt-in write half of the flow, as one imperative action: upload the HAR
 * archive if the pick is local, then persist the previewed resources, each
 * stamped with the archive it came from.
 *
 * @remarks
 * This is the seam the preview-then-confirm promise rests on — nothing here runs
 * until the user confirms a preview they have seen. The order is fixed and
 * load-bearing:
 *
 * 1. **Secure provenance.** A `local` pick has bytes the server has never seen,
 *    so its archive is uploaded first (`useUploadHar`, a fresh uuid per the epic
 *    decision) and the reference the upload mints becomes the `meta.source` every
 *    written resource carries. A `server` pick already names the archive it was
 *    fetched from, so it skips the upload entirely and links to that document.
 * 2. **Write the resources.** `persistPreview` runs only after the archive
 *    reference exists, so the archive create always lands before the first
 *    resource write and no resource is ever written pointing at an archive that
 *    is not there yet.
 *
 * `persistPreview` returns its failures as data and never throws, so the only
 * rejection this can surface is the upload's (a `local` pick whose archive PUT
 * failed) — folded into an `errored` state. Failures that come back as data fold
 * into `partial` under the `collectImportSummary` semantics: any failure at all
 * makes the whole import partial.
 *
 * @packageDocumentation
 */

/**
 * The lifecycle of one confirm, mapped onto the results the screen renders.
 *
 * @remarks
 * `complete` and `partial` both carry the full {@link ImportOutcome}; they differ
 * only in whether any resource failed to write, which is the one bit the results
 * view branches on. `errored` carries the upload's rejection cause — the write
 * itself cannot reach this state.
 */
type ConfirmState =
  | { readonly _tag: 'idle' }
  | { readonly _tag: 'confirming' }
  | { readonly _tag: 'complete'; readonly outcome: ImportOutcome }
  | { readonly _tag: 'partial'; readonly outcome: ImportOutcome }
  | { readonly _tag: 'errored'; readonly error: unknown }

/** What a confirm needs: the picked HAR and the claimed preview it produced. */
interface ConfirmInput {
  readonly picked: PickedHar
  readonly preview: Preview
}

/** Imperative surface the screen drives the confirm through. */
interface ConfirmImport {
  readonly state: ConfirmState
  /** Run the upload-then-persist action for a confirmed preview. */
  readonly confirm: (input: ConfirmInput) => void
  /** Discard the outcome and return to `idle` (a "start over" from results). */
  readonly reset: () => void
}

/**
 * The archive reference a confirm writes against: a `server` pick's own
 * reference, or the reference minted by uploading a `local` pick's bytes.
 *
 * @remarks
 * A `local` pick's bytes are encoded from its text at the call site — the upload
 * takes bytes, not text, so the stored archive is verbatim and its attachment
 * hash means something. A `server` pick uploads nothing and links to the document
 * it was fetched from.
 */
const secureSourceRef = (
  picked: PickedHar,
  uploadHar: ReturnType<typeof useUploadHar>
): Promise<string> => {
  if (picked.source._tag === 'server') return Promise.resolve(picked.source.reference)
  return uploadHar
    .mutateAsync({ fileName: picked.fileName, bytes: new TextEncoder().encode(picked.text) })
    .then((id) => harArchiveReference(id))
}

/**
 * Drives a single confirmed import — upload (if local) then persist — as an
 * imperative action, mapping its lifecycle onto {@link ConfirmState}. The authed
 * runner and the upload mutation both come from router context via
 * `fhir-r4-react`, so mount this inside the host app's router and
 * `QueryClientProvider`.
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
    ({ picked, preview }: ConfirmInput): void => {
      latest.current += 1
      const ticket = latest.current
      setState({ _tag: 'confirming' })
      void (async (): Promise<void> => {
        try {
          const sourceRef = await secureSourceRef(picked, uploadHar)
          const failures = await runAuthed(persistPreview(preview, sourceRef))
          if (latest.current !== ticket) return
          const outcome = importOutcome(preview, sourceRef, failures)
          setState(
            isPartialOutcome(outcome) ? { _tag: 'partial', outcome } : { _tag: 'complete', outcome }
          )
        } catch (error) {
          if (latest.current !== ticket) return
          setState({ _tag: 'errored', error })
        }
      })()
    },
    [runAuthed, uploadHar]
  )

  const reset = useCallback((): void => {
    latest.current++
    setState({ _tag: 'idle' })
  }, [])

  return { state, confirm, reset }
}

export { type ConfirmImport, type ConfirmInput, type ConfirmState, useConfirmImport }
