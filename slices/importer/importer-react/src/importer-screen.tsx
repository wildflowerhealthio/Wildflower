import type { DiffStatus } from 'fhir-r4/clients'
import type { FhirResource } from 'fhir-r4/resources'
import { acceptFor, Review, sectionResources } from 'importer-fundamentals'
import { type JSX, useCallback, useState } from 'react'

import { PreviewPanel } from './preview/preview-panel.tsx'
import { useConfirmImport } from './preview/use-confirm-import.ts'
import { useImportRun } from './preview/use-import-run.ts'
import { initialExclusionsFor, useServerDiff } from './preview/use-server-diff.ts'
import { formatRegistry } from './registry.ts'
import { ImportResults } from './results/import-results.tsx'
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
 * file decodes to sections of labeled resources the reviewer can exclude or
 * edit — and only the explicit confirm reaches the write half
 * (`useConfirmImport` — upload-then-persist, per file, verbatim from the
 * preview, best-effort). A batch may span formats: the picker identifies
 * each file against the registered descriptors, every downstream step
 * dispatches on the file's `format` tag, and the preview mounts one
 * settings form per format present — a settings change re-decodes that
 * format's files through `useImportRun.applySettings`. Per-resource
 * selections are keyed by stable resource keys, so they survive a
 * re-decode where the resource does.
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

/** The bound descriptors, one per registered format, in registry order. */
const registeredDescriptors = Object.values(formatRegistry)

/**
 * The OS dialog's `accept` attribute — the union of every registered
 * format's `accept` tokens, so a user sees the extensions of every format
 * the app supports in one dialog. The hint is only that; a file whose
 * format doesn't match any descriptor falls through to the picker's own
 * rejection via `detect`.
 */
const PICKER_ACCEPT = acceptFor(registeredDescriptors)

/**
 * The empty diff-status map, held once so `PreviewPanel`'s `diffStatuses`
 * prop keeps its reference identity while the pre-fetch is in flight — the
 * panel re-renders on the transition to `ready`, not on every mount.
 */
const EMPTY_DIFF_STATUSES: ReadonlyMap<string, DiffStatus> = new Map()

/** The importer flow. Takes no props — it reads everything from router context. */
const ImporterScreen = (): JSX.Element => {
  const importRun = useImportRun(formatRegistry)
  const confirm = useConfirmImport(formatRegistry)

  const [selections, setSelections] = useState<ReadonlyMap<string, Review.Selection<FhirResource>>>(
    new Map()
  )

  const readFiles = importRun.state._tag === 'ready' ? importRun.state.files : undefined
  const diff = useServerDiff(readFiles)
  const diffStatuses: ReadonlyMap<string, DiffStatus> =
    diff._tag === 'ready' ? diff.statuses : EMPTY_DIFF_STATUSES

  const selectionFor = useCallback(
    (fileId: string): Review.Selection<FhirResource> => {
      const user = selections.get(fileId)
      if (user !== undefined) return user
      // Seed the initial selection from the server-diff status: an
      // `unchanged` resource is pre-excluded so a re-import writes nothing
      // by default. As soon as the reviewer toggles anything,
      // `selections.get(fileId)` wins and this seed is out of the picture.
      if (diff._tag !== 'ready' || readFiles === undefined) return Review.initial<FhirResource>()
      const file = readFiles.find(
        (candidate) => candidate.id === fileId && candidate._tag === 'read'
      )
      if (file === undefined || file._tag !== 'read') return Review.initial<FhirResource>()
      const labeled = sectionResources(file.decoded.sections)
      if (labeled.length === 0) return Review.initial<FhirResource>()
      return {
        excludedResources: initialExclusionsFor(labeled, diff.statuses),
        resourceOverrides: new Map(),
      }
    },
    [selections, diff, readFiles]
  )

  const onSelectionChange = useCallback(
    (fileId: string, selection: Review.Selection<FhirResource>): void => {
      setSelections((previous) => new Map(previous).set(fileId, selection))
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

  const body = ((): JSX.Element => {
    const runState = importRun.state
    if (runState._tag === 'idle')
      return (
        <SourcePicker
          descriptors={registeredDescriptors}
          onPick={importRun.run}
          accept={PICKER_ACCEPT}
        />
      )
    if (runState._tag === 'reading') {
      return (
        <p role="status" className={styles.status}>
          {READING_MESSAGE}
        </p>
      )
    }
    return (
      <PreviewPanel
        files={runState.files}
        settings={importRun.settings}
        settingsRegistry={formatRegistry}
        selectionFor={selectionFor}
        diffStatuses={diffStatuses}
        onSelectionChange={onSelectionChange}
        onSettingsChange={importRun.applySettings}
        confirming={confirming}
        onCancel={startOver}
        onConfirm={() => confirm.confirm(runState.files, selectionFor)}
      />
    )
  })()

  return <div className={styles.screen}>{body}</div>
}

export { ImporterScreen, READING_MESSAGE }
