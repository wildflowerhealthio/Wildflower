import type { FhirResource } from 'fhir-r4/resources'
import { Review } from 'importer-fundamentals'
import { type JSX, useCallback, useMemo, useState } from 'react'

import { PreviewPanel } from './preview/preview-panel.tsx'
import { emptyResolveCache, type ResolveCache, resolvedFor } from './preview/previews-for.ts'
import { useConfirmImport } from './preview/use-confirm-import.ts'
import { type FileReadOutcome, useImportRun } from './preview/use-import-run.ts'
import { formatRegistry } from './registry.tsx'
import { ImportResults } from './results/import-results.tsx'
import { SourcePicker } from './sources/source-picker.tsx'
import styles from './importer-screen.module.css'

/**
 * The whole importer flow, top to bottom: pick one or more files, review exactly
 * what they would write (per resource), confirm once to write the included
 * resources, and read the results.
 *
 * @remarks
 * The screen is the opt-in seam made visible: the read half
 * (`SourcePicker` → `useImportRun` → `PreviewPanel`) writes nothing, resolves
 * the format's opaque review state into labeled resources so the reviewer sees
 * the actual resources, and only the explicit confirm reaches the write half
 * (`useConfirmImport` — upload-then-persist, per file, verbatim from the
 * preview, best-effort). A cancel or "import another archive" discards
 * everything with nothing further written.
 *
 * The slice owns every level of this flow rather than the host app: an app mounts
 * only this screen. Mount it inside the host's router and `QueryClientProvider` —
 * the authed runner and the FHIR client both come from router context via
 * `fhir-r4-react`.
 *
 * @packageDocumentation
 */

/** The message shown while a batch is being read into review states. */
const READING_MESSAGE = 'Reading the archives…'

/** The bound format the flow uses today. */
const format = formatRegistry.har

/** The importer flow. Takes no props — it reads everything from router context. */
const ImporterScreen = (): JSX.Element => {
  const importRun = useImportRun(format)
  const confirm = useConfirmImport(format)

  // Per-file review state overrides from ReviewBody changes. Falls back to the
  // decode's initial review for files not in this map.
  const [reviewOverrides, setReviewOverrides] = useState<ReadonlyMap<string, unknown>>(new Map())
  const [selections, setSelections] = useState<ReadonlyMap<string, Review.Selection<FhirResource>>>(
    new Map()
  )

  const readFiles = importRun.state._tag === 'ready' ? importRun.state.files : undefined

  const initialReviews = useMemo(() => {
    if (!readFiles) return new Map<string, unknown>()
    return new Map(
      readFiles
        .filter((f): f is Extract<FileReadOutcome, { _tag: 'read' }> => f._tag === 'read')
        .map((f) => [f.id, f.review] as const)
    )
  }, [readFiles])

  const reviewFor = useCallback(
    (fileId: string): unknown => reviewOverrides.get(fileId) ?? initialReviews.get(fileId),
    [reviewOverrides, initialReviews]
  )

  const onReviewChange = useCallback((_fileId: string, review: unknown): void => {
    setReviewOverrides((prev) => new Map(prev).set(_fileId, review))
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

  // Resolve labeled resources from the review state, cached by review identity.
  // useState's lazy initialiser gives a stable per-mount reference without
  // repeated allocation.
  const [resolveCache] = useState<ResolveCache>(emptyResolveCache)
  const labeled = useMemo(
    () =>
      readFiles === undefined
        ? undefined
        : resolvedFor(format.resolve, readFiles, reviewFor, resolveCache),
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
    if (runState._tag === 'idle') return <SourcePicker onPick={importRun.run} />
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
        ReviewBody={format.ReviewBody}
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
