import type { JSX } from 'react'

import { PreviewPanel } from './preview/preview-panel.tsx'
import { useConfirmImport } from './preview/use-confirm-import.ts'
import { useImportRun } from './preview/use-import-run.ts'
import { ImportResults } from './results/import-results.tsx'
import { SourcePicker } from './sources/source-picker.tsx'
import styles from './importer-screen.module.css'

/**
 * The whole importer flow, top to bottom: pick one or more HARs, preview exactly
 * what they would write, confirm once to write them, and read the results.
 *
 * @remarks
 * The screen is the opt-in seam made visible. The read half runs on a pick and
 * writes nothing — `SourcePicker` → `useImportRun` (`HarImport.run`, once per
 * picked file) → `PreviewPanel`, which shows every file's outcome under one
 * confirm. Only the explicit confirm reaches the write half — `useConfirmImport`,
 * which for each writable file uploads its HAR archive when the pick is local (so
 * every written resource's `meta.source` names it) and then persists that file's
 * resources. Best-effort: one file's failed upload does not stop the rest, and it
 * lands as its own row in the results. A cancel from the preview, or "import
 * another archive" from the results, discards everything and returns to the
 * picker with nothing further written.
 *
 * The slice owns every level of this flow rather than the host app: an app mounts
 * only this screen, the same lesson the web-trace viewer learned about split
 * surfaces. Mount it inside the host's router and `QueryClientProvider` — the
 * authed runner and the FHIR client both come from router context via
 * `fhir-r4-react`.
 *
 * @packageDocumentation
 */

/** The message shown while a batch is being read into a preview. */
const READING_MESSAGE = 'Reading the archives…'

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

  // A finished confirm is terminal for this run — show the results regardless of
  // what the read state still holds behind it.
  if (confirm.state._tag === 'done') {
    return (
      <div className={styles.screen}>
        <ImportResults batch={confirm.state.batch} onStartOver={startOver} />
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
    // `ready` holds every picked file's outcome; the confirm step writes only the
    // files whose preview is a claimed `Preview` with resources, which is exactly
    // the case `PreviewPanel` shows the confirm action for.
    return (
      <PreviewPanel
        files={runState.files}
        confirming={confirming}
        onCancel={startOver}
        onConfirm={() => confirm.confirm(runState.files)}
      />
    )
  })()

  return <div className={styles.screen}>{body}</div>
}

export { ImporterScreen, READING_MESSAGE }
