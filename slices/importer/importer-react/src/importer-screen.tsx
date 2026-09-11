import type { FhirResource } from 'fhir-r4/resources'
import { acceptFor, Review } from 'importer-fundamentals'
import { type JSX, useCallback, useMemo, useState } from 'react'

import { PreviewPanel } from './preview/preview-panel.tsx'
import { emptyResolveCache, resolvedFor } from './preview/previews-for.ts'
import { useConfirmImport } from './preview/use-confirm-import.ts'
import { type ReadFile, useImportRun } from './preview/use-import-run.ts'
import { type FormatReview, formatRegistry } from './registry.tsx'
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
 * (`SourcePicker` → `useImportRun` → `PreviewPanel`) writes nothing,
 * resolves each file's opaque review state into labeled resources so the
 * reviewer sees the actual resources, and only the explicit confirm reaches
 * the write half (`useConfirmImport` — upload-then-persist, per file,
 * verbatim from the preview, best-effort). A batch may span formats: the
 * picker identifies each file against the registered descriptors, and every
 * downstream step dispatches on the file's `format` tag.
 *
 * Review state is held per file as a {@link FormatReview} — a tagged pair
 * of `{ format, review }` — so a `fileId → override` map preserves the K
 * correlation TS would otherwise collapse to a union.
 *
 * The slice owns every level of this flow rather than the host app: an app
 * mounts only this screen. Mount it inside the host's router and
 * `QueryClientProvider` — the authed runner and the FHIR client both come
 * from router context via `fhir-r4-react`.
 *
 * @packageDocumentation
 */

/** The message shown while a batch is being read into review states. */
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
 * A `read` file's tagged review from its outcome — the initial value before
 * any override. A {@link ReadFile} is a K-distributed union whose `format`
 * and `review` fields are already correlated, so structurally it satisfies
 * {@link FormatReview}; picking the two fields off explicitly would widen
 * them to unions and lose the correlation, so we hand the file object
 * through directly.
 */
const initialReviewOf = (file: ReadFile): FormatReview => file

/** The importer flow. Takes no props — it reads everything from router context. */
const ImporterScreen = (): JSX.Element => {
  const importRun = useImportRun(formatRegistry)
  const confirm = useConfirmImport(formatRegistry)

  const [reviewOverrides, setReviewOverrides] = useState<ReadonlyMap<string, FormatReview>>(
    new Map()
  )
  const [selections, setSelections] = useState<ReadonlyMap<string, Review.Selection<FhirResource>>>(
    new Map()
  )

  const readFiles = importRun.state._tag === 'ready' ? importRun.state.files : undefined

  const reviewFor = useCallback(
    (file: ReadFile): FormatReview => reviewOverrides.get(file.id) ?? initialReviewOf(file),
    [reviewOverrides]
  )

  const onReviewChange = useCallback((fileId: string, tagged: FormatReview): void => {
    setReviewOverrides((previous) => new Map(previous).set(fileId, tagged))
  }, [])

  const selectionFor = useCallback(
    (fileId: string): Review.Selection<FhirResource> =>
      selections.get(fileId) ?? Review.initial<FhirResource>(),
    [selections]
  )

  const onSelectionChange = useCallback(
    (fileId: string, selection: Review.Selection<FhirResource>): void => {
      setSelections((previous) => new Map(previous).set(fileId, selection))
    },
    []
  )

  const [resolveCache] = useState(() => emptyResolveCache())
  const labeled = useMemo(
    () =>
      readFiles === undefined
        ? undefined
        : resolvedFor(formatRegistry, readFiles, reviewFor, resolveCache),
    [readFiles, reviewFor, resolveCache]
  )
  const labeledFor = useCallback((fileId: string) => labeled?.get(fileId) ?? [], [labeled])

  const startOver = (): void => {
    confirm.reset()
    importRun.reset()
    setSelections(new Map())
    setReviewOverrides(new Map())
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
        reviewBodyRegistry={formatRegistry}
        reviewFor={reviewFor}
        labeledFor={labeledFor}
        selectionFor={selectionFor}
        onReviewChange={onReviewChange}
        onSelectionChange={onSelectionChange}
        confirming={confirming}
        onCancel={startOver}
        onConfirm={() => confirm.confirm(runState.files, labeledFor, selectionFor)}
      />
    )
  })()

  return <div className={styles.screen}>{body}</div>
}

export { ImporterScreen, READING_MESSAGE }
