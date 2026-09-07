import { type JSX, useCallback, useMemo, useState } from 'react'

import { SourceDescriptor } from 'http-extraction-fundamentals'
import { Review } from 'importer-fundamentals'

import { PreviewPanel } from './preview/preview-panel.tsx'
import { previewsFor } from './preview/previews-for.ts'
import { useConfirmImport } from './preview/use-confirm-import.ts'
import { useImportRun } from './preview/use-import-run.ts'
import { formatRegistry } from './registry.ts'
import { ImportResults } from './results/import-results.tsx'
import { SourcePicker } from './sources/source-picker.tsx'
import styles from './importer-screen.module.css'

/**
 * The whole importer flow, top to bottom: pick one or more HARs, review exactly
 * what they would write (per URL, per resource), confirm once to write the
 * included resources, and read the results.
 *
 * @remarks
 * The screen is the opt-in seam made visible: the read half
 * (`SourcePicker` → `useImportRun` → `PreviewPanel`) writes nothing, parses at
 * preview so the reviewer sees the actual resources, and only the explicit
 * confirm reaches the write half (`useConfirmImport` — upload-then-persist, per
 * file, verbatim from the preview, best-effort). A cancel or "import another
 * archive" discards everything with nothing further written. The flow and
 * package roles are in this package's AGENTS.md.
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

/** The descriptor's sources flattened once — what a default selection seeds from. */
const pool = SourceDescriptor.poolOf(descriptor.sources)

/** The importer flow. Takes no props — it reads everything from router context. */
const ImporterScreen = (): JSX.Element => {
  const importRun = useImportRun(descriptor)
  const confirm = useConfirmImport(descriptor)
  // Each read file's reviewed selection, keyed by its stable id. Absent = the
  // default (every kind enabled, every resource included), so a file the user
  // never touched still imports everything recognized.
  const [selections, setSelections] = useState<ReadonlyMap<string, Review.Selection>>(new Map())

  const selectionFor = useCallback(
    (fileId: string): Review.Selection => selections.get(fileId) ?? Review.initial(pool),
    [selections]
  )

  const onSelectionChange = useCallback((fileId: string, selection: Review.Selection): void => {
    setSelections((previous) => new Map(previous).set(fileId, selection))
  }, [])

  // The read half's resource-level output, shared with the confirm step so the
  // same objects the reviewer inspected are what gets written.
  const readFiles = importRun.state._tag === 'ready' ? importRun.state.files : undefined
  const previews = useMemo(
    () =>
      readFiles === undefined
        ? undefined
        : previewsFor(descriptor.sources, readFiles, selectionFor),
    [readFiles, selectionFor]
  )
  const previewFor = useCallback((fileId: string) => previews?.get(fileId) ?? [], [previews])

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
    // resources each file's review kept included, which is exactly what
    // `PreviewPanel` gates the confirm action on.
    return (
      <PreviewPanel
        files={runState.files}
        sources={descriptor.sources}
        ReviewBody={ReviewBody}
        selectionFor={selectionFor}
        onSelectionChange={onSelectionChange}
        previewFor={previewFor}
        confirming={confirming}
        onCancel={startOver}
        onConfirm={() => confirm.confirm(runState.files, previewFor, selectionFor)}
      />
    )
  })()

  return <div className={styles.screen}>{body}</div>
}

export { ImporterScreen, READING_MESSAGE }
