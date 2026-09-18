import type { FormatKind } from 'importer-core'
import { formatKinds } from 'importer-core'
import { StagedImport, DecodedFile } from 'importer-fundamentals'
import { type JSX, useCallback, useMemo, useState } from 'react'

import { PreviewPanel } from './preview/preview-panel.tsx'
import { initialExclusionsFor, useServerDiff } from './preview/use-server-diff.ts'
import { formatRegistry } from './registry.ts'
import { ImportResults } from './results/import-results.tsx'
import { useConfirmImport } from './run/use-confirm-import.ts'
import { useImportRun } from './run/use-import-run.ts'
import { SourcePicker } from './sources/source-picker.tsx'
import styles from './importer-screen.module.css'

/**
 * The whole importer flow, top to bottom: pick one or more files, review
 * exactly what they would write (per resource), confirm once to write the
 * included resources, and read the results.
 *
 * @remarks
 * The screen is the opt-in seam made visible: the read half
 * (`SourcePicker` → `useImportRun` → `PreviewPanel`) writes nothing — each
 * file decodes to resources grouped by format, its own source file among
 * them, that the reviewer can exclude or edit — and only the explicit
 * confirm reaches the write half (`useConfirmImport` — one batch bundle per
 * format, verbatim from the preview, best-effort). A batch may span formats:
 * the picker identifies each file against the registered detectors,
 * `importer-core` groups and decodes by format, and the preview mounts one
 * settings form per format present — a settings change re-decodes that
 * format through `useImportRun.applySettings`. Per-resource selections are
 * keyed by format kind and stable resource key, so they survive a re-decode
 * where the resource does.
 *
 * The slice owns every level of this flow rather than the host app: an app
 * mounts only this screen. Mount it inside the host's router and
 * `QueryClientProvider` — the authed runner and the FHIR client both come
 * from router context via `fhir-r4-react`.
 *
 * @packageDocumentation
 */

/** The message shown while a batch is being read into decoded sections. */
const READING_MESSAGE = 'Reading the files…'

/**
 * The message shown after reading, while the server diff is in flight — the
 * preview waits on it rather than painting rows whose badges pop in a moment
 * later.
 */
const CHECKING_SERVER_MESSAGE = 'Checking the server for existing copies…'

const SERVER_DIFF_ERROR_MESSAGE =
  'Could not check the server for existing copies. Duplicate detection is unavailable — all resources will appear as new.'

/** The registered formats' detectors, in registry (priority) order. */
const registeredDetectors = Object.values(formatRegistry)

/** The importer flow. Takes no props — it reads everything from router context. */
const ImporterScreen = (): JSX.Element => {
  const importRun = useImportRun()
  const confirm = useConfirmImport()

  const [selections, setSelections] = useState<ReadonlyMap<FormatKind, StagedImport.Selection>>(
    new Map()
  )

  const runState = importRun.state
  const batch = runState._tag === 'ready' ? runState.batch : undefined
  const diff = useServerDiff(batch, runState._tag === 'ready' ? runState.batchId : 0)

  const initialSelections = useMemo((): ReadonlyMap<FormatKind, StagedImport.Selection> => {
    if (diff._tag === 'loading' || batch === undefined) return new Map()
    const entries: [FormatKind, StagedImport.Selection][] = []
    for (const kind of formatKinds) {
      const result = batch[kind]
      if (result.files.length === 0) continue
      const labeled = DecodedFile.resources(result.decoded)
      const excluded = initialExclusionsFor(labeled, diff.comparisons.get(kind))
      if (excluded.size > 0) {
        entries.push([kind, { excludedResources: excluded, resourceOverrides: new Map() }])
      }
    }
    return new Map(entries)
  }, [diff, batch])

  const selectionFor = useCallback(
    (format: FormatKind): StagedImport.Selection =>
      selections.get(format) ?? initialSelections.get(format) ?? StagedImport.initial(),
    [selections, initialSelections]
  )

  const onSelectionChange = useCallback(
    (format: FormatKind, selection: StagedImport.Selection): void => {
      setSelections((previous) => new Map(previous).set(format, selection))
    },
    []
  )

  const startOver = (): void => {
    confirm.reset()
    importRun.reset()
    setSelections(new Map())
  }

  if (confirm.state._tag === 'done') {
    return (
      <div className={styles.screen}>
        <ImportResults batch={confirm.state.batch} onStartOver={startOver} />
      </div>
    )
  }

  const confirming = confirm.state._tag === 'confirming'
  const confirmBlocked = confirming || importRun.redecoding

  const body = ((): JSX.Element => {
    if (runState._tag === 'idle')
      return <SourcePicker detectors={registeredDetectors} onPick={importRun.run} />
    if (runState._tag === 'reading') {
      return (
        <p role="status" className={styles.status}>
          {READING_MESSAGE}
        </p>
      )
    }
    // Block the preview while there is nothing worth showing, so every row
    // paints with its badge already resolved — no mid-render pop-in a second
    // after the panel shows. A settings change keeps the previous batch's
    // verdicts on screen instead of coming back here: blocking on a re-decode
    // would unmount the panel, and the settings input the reviewer is typing
    // into with it.
    if (diff._tag === 'loading') {
      return (
        <p role="status" className={styles.status}>
          {CHECKING_SERVER_MESSAGE}
        </p>
      )
    }
    return (
      <>
        {diff._tag === 'error' && (
          <p role="alert" className={styles.error}>
            {SERVER_DIFF_ERROR_MESSAGE}
          </p>
        )}
        <PreviewPanel
          batch={runState.batch}
          settings={importRun.settings}
          settingsRegistry={formatRegistry}
          selectionFor={selectionFor}
          comparisons={diff.comparisons}
          onSelectionChange={onSelectionChange}
          onSettingsChange={importRun.applySettings}
          confirming={confirming}
          confirmDisabled={confirmBlocked}
          onCancel={startOver}
          onConfirm={() => confirm.confirm(runState.batch, selectionFor)}
        />
      </>
    )
  })()

  return <div className={styles.screen}>{body}</div>
}

export { CHECKING_SERVER_MESSAGE, ImporterScreen, READING_MESSAGE, SERVER_DIFF_ERROR_MESSAGE }
