import type { JSX } from 'react'

import { PreviewPanel } from './preview/preview-panel.tsx'
import { useConfirmImport } from './preview/use-confirm-import.ts'
import { useImportRun } from './preview/use-import-run.ts'
import { ImportResults } from './results/import-results.tsx'
import { SourcePicker } from './sources/source-picker.tsx'
import styles from './importer-screen.module.css'

/**
 * The whole importer flow, top to bottom: pick a HAR, preview exactly what it
 * would write, confirm once to write it, and read the results.
 *
 * @remarks
 * The screen is the opt-in seam made visible. The read half runs on a pick and
 * writes nothing — `SourcePicker` → `useImportRun` (`runHarImport`) →
 * `PreviewPanel`. Only the explicit confirm reaches the write half —
 * `useConfirmImport`, which uploads the HAR archive when the pick is local (so
 * every written resource's `meta.source` names it) and then persists the
 * previewed resources. A cancel from the preview, or "import another archive"
 * from the results, discards everything and returns to the picker with nothing
 * written.
 *
 * The slice owns every level of this flow rather than the host app: an app mounts
 * only this screen, the same lesson the web-trace viewer learned about split
 * surfaces. Mount it inside the host's router and `QueryClientProvider` — the
 * authed runner and the FHIR client both come from router context via
 * `fhir-r4-react`.
 *
 * @packageDocumentation
 */

/** The message shown while an archive is being read into a preview. */
const READING_MESSAGE = 'Reading the archive…'

/** The message shown when an archive is not a well-formed HAR. */
const UNREADABLE_MESSAGE = 'That archive could not be read as a HAR file.'

/** The importer flow. Takes no props — it reads everything from router context. */
const ImporterScreen = (): JSX.Element => {
  const importRun = useImportRun()
  const confirm = useConfirmImport()

  // Discard everything — the read and any confirm outcome — and return to the
  // picker. The reset order does not matter; both drop to `idle`.
  const startOver = (): void => {
    confirm.reset()
    importRun.reset()
  }

  // A finished confirm (or its error) is terminal for this run — show the results
  // regardless of what the read state still holds behind it.
  if (confirm.state._tag === 'complete' || confirm.state._tag === 'partial') {
    return (
      <div className={styles.screen}>
        <ImportResults
          outcome={confirm.state.outcome}
          partial={confirm.state._tag === 'partial'}
          onStartOver={startOver}
        />
      </div>
    )
  }
  if (confirm.state._tag === 'errored') {
    return (
      <div className={styles.screen}>
        <section aria-label="Import results" className={styles.message}>
          <h2 className={styles.heading}>The import could not be completed</h2>
          <p role="alert" className={styles.error}>
            The HAR archive could not be uploaded, so nothing was written. Try again.
          </p>
          <button type="button" className={styles.back} onClick={startOver}>
            Back to sources
          </button>
        </section>
      </div>
    )
  }

  const confirming = confirm.state._tag === 'confirming'

  const body = ((): JSX.Element => {
    const runState = importRun.state
    if (runState._tag === 'idle') return <SourcePicker onPick={importRun.run} />
    if (runState._tag === 'reading') {
      return (
        <p role="status" className={styles.status}>
          {READING_MESSAGE}
        </p>
      )
    }
    if (runState._tag === 'unreadable') {
      return (
        <section aria-label="Import preview" className={styles.message}>
          <p role="alert" className={styles.error}>
            {UNREADABLE_MESSAGE}
          </p>
          <button type="button" className={styles.back} onClick={startOver}>
            Back to sources
          </button>
        </section>
      )
    }
    // `ready` holds the whole `ImportPreview` union; the confirm step only takes a
    // claimed `Preview`, so the write is gated on that narrowing — which is exactly
    // the case `PreviewPanel` shows the confirm action for.
    const { picked, preview } = runState
    return (
      <PreviewPanel
        preview={preview}
        confirming={confirming}
        onCancel={startOver}
        onConfirm={() => {
          if (preview._tag === 'Preview') confirm.confirm({ picked, preview })
        }}
      />
    )
  })()

  return <div className={styles.screen}>{body}</div>
}

export { ImporterScreen, READING_MESSAGE, UNREADABLE_MESSAGE }
