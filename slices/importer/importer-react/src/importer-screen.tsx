import { type JSX, useCallback, useState } from 'react'

import { Review } from 'importer-fundamentals'

import { PreviewPanel } from './preview/preview-panel.tsx'
import { useConfirmImport } from './preview/use-confirm-import.ts'
import { useImportRun } from './preview/use-import-run.ts'
import { formatRegistry } from './registry.ts'
import { ImportResults } from './results/import-results.tsx'
import { SourcePicker } from './sources/source-picker.tsx'
import styles from './importer-screen.module.css'

/**
 * The whole importer flow, top to bottom: pick one or more HARs, review exactly
 * what they would write, confirm once to write the chosen responses, and read the
 * results.
 *
 * @remarks
 * The screen is the opt-in seam made visible. It composes the closed
 * `format → { descriptor, SettingsPicker, ReviewBody }` registry — HAR is the one
 * format today. The read half runs on a pick and writes nothing —
 * `SourcePicker` → `useImportRun` (the descriptor's `decode`, once per picked
 * file) → `PreviewPanel`, which renders every file's interactive `ReviewBody`
 * under one confirm. Only the explicit confirm reaches the write half —
 * `useConfirmImport`, which for each file with a chosen response uploads its HAR
 * archive when the pick is local (so every written resource's `meta.source` names
 * it) and then decodes and persists that file's chosen responses. Best-effort:
 * one file's failed upload does not stop the rest, and it lands as its own row in
 * the results. A cancel from the preview, or "import another archive" from the
 * results, discards everything and returns to the picker with nothing further
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

/** The message shown while a batch is being read into a preview. */
const READING_MESSAGE = 'Reading the archives…'

/** The one registered format today. Its descriptor + interactive review drive the flow. */
const { descriptor, ReviewBody } = formatRegistry.har

/** The importer flow. Takes no props — it reads everything from router context. */
const ImporterScreen = (): JSX.Element => {
  const importRun = useImportRun(descriptor)
  const confirm = useConfirmImport(descriptor)
  // Each read file's reviewed selection, keyed by its stable id. Absent = the
  // default (every kind enabled), so a file the user never touched still imports
  // everything recognized.
  const [selections, setSelections] = useState<ReadonlyMap<string, Review.Selection>>(new Map())

  const selectionFor = useCallback(
    (fileId: string): Review.Selection => selections.get(fileId) ?? Review.initial(descriptor.pool),
    [selections]
  )

  const onSelectionChange = useCallback((fileId: string, selection: Review.Selection): void => {
    setSelections((previous) => new Map(previous).set(fileId, selection))
  }, [])

  // Discard everything — the read, any confirm outcome, and every review edit —
  // and return to the picker. The reset order does not matter; all drop to empty.
  const startOver = (): void => {
    confirm.reset()
    importRun.reset()
    setSelections(new Map())
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
    // responses each file's review chose, which is exactly what `PreviewPanel`
    // gates the confirm action on.
    return (
      <PreviewPanel
        files={runState.files}
        pool={descriptor.pool}
        ReviewBody={ReviewBody}
        selectionFor={selectionFor}
        onSelectionChange={onSelectionChange}
        confirming={confirming}
        onCancel={startOver}
        onConfirm={() => confirm.confirm(runState.files, selectionFor)}
      />
    )
  })()

  return <div className={styles.screen}>{body}</div>
}

export { ImporterScreen, READING_MESSAGE }
