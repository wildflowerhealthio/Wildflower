import type { FhirResource } from 'fhir-r4/resources'
import type { LabeledResource } from 'importer-fundamentals'
import { Review } from 'importer-fundamentals'
import { type JSX, useMemo } from 'react'

import type { BoundFormat, FormatKind, FormatReview } from '../registry.tsx'
import type { FileReadOutcome } from './use-import-run.ts'
import styles from './preview-panel.module.css'

/**
 * The preview view: an interactive per-resource review of exactly what
 * the import would write, shown before anything touches the server, so
 * confirming is an informed, opt-in act.
 *
 * @remarks
 * A pick is a *batch* of one or more files, each read independently and
 * rendered together under one confirm: a read file gets its own format's
 * interactive `ReviewBody` (or a default per-resource list when the format
 * has none), an unreadable one is reported against its own name rather
 * than sinking the batch. Because a batch may span formats, each file's
 * render dispatches on its tagged review's `format` — the pair is a
 * {@link FormatReview}, so `Match.value(tagged).pipe(Match.when({ format:
 * 'har' }, …))` narrows both the review type and the matching
 * `ReviewBody` component per branch, no cast. The confirm appears only
 * when at least one resource is included, and it does not write — it
 * calls `onConfirm`; the confirm step writes exactly the reviewed
 * objects.
 *
 * @packageDocumentation
 */

/** The registry-shaped structure this panel reads to render each file's review body. */
type ReviewBodyRegistry = {
  readonly [K in FormatKind]: Pick<BoundFormat<K>, 'ReviewBody'>
}

/** Props for {@link PreviewPanel}. */
interface PreviewPanelProps {
  /** Every picked file's read outcome, rendered together under one confirm. */
  readonly files: readonly FileReadOutcome[]
  /** The registered formats' `ReviewBody` components (or `null`) indexed by kind. */
  readonly reviewBodyRegistry: ReviewBodyRegistry
  /** The tagged review to render for a read file — override if present, otherwise the file's own. */
  readonly reviewFor: (file: Extract<FileReadOutcome, { readonly _tag: 'read' }>) => FormatReview
  /** The resolved labeled resources for a file. */
  readonly labeledFor: (fileId: string) => readonly LabeledResource<FhirResource>[]
  /** The reviewed selection for a file (defaults to `Review.initial()` before any edit). */
  readonly selectionFor: (fileId: string) => Review.Selection<FhirResource>
  /**
   * Called when a format-specific ReviewBody changes the review state.
   * The tagged pair carries the file's format so the caller can store it
   * without inspecting the file again.
   */
  readonly onReviewChange: (fileId: string, tagged: FormatReview) => void
  /** Called when a file's review changes its selection. */
  readonly onSelectionChange: (fileId: string, selection: Review.Selection<FhirResource>) => void
  /**
   * Called when the user confirms the batch. Fires only when at least one
   * resource is included; the panel gates the affordance, so a caller can
   * treat this as "the user opted in to writing the batch".
   */
  readonly onConfirm: () => void
  /** Called when the user discards the preview without writing. */
  readonly onCancel: () => void
  /** Whether a confirmed import is currently running, to disable the action. */
  readonly confirming: boolean
}

/** Heading for a batch with nothing chosen — no resource is included. */
const NOTHING_TO_IMPORT_HEADING = 'Nothing to import'

/** Heading for a batch that has resources to write. */
const PREVIEW_HEADING = 'Ready to import'

/** Message for a file that did not parse at all. */
const UNREADABLE_FILE_MESSAGE = 'This file could not be read.'

/** Message for a file no registered format recognized. */
const UNRECOGNIZED_FILE_MESSAGE = 'This file was not a format the importer recognizes.'

/** `noun` singular when `count === 1`, else its `-s` plural. */
const plural = (count: number, noun: string): string => (count === 1 ? noun : `${noun}s`)

/** The confirm button's label, factored out so the render stays a single expression. */
const confirmLabel = (writable: number, excluded: number, confirming: boolean): string => {
  if (confirming) return 'Importing…'
  const base = `Import ${writable} ${plural(writable, 'resource')}`
  return excluded > 0 ? `${base} (${excluded} excluded)` : base
}

/**
 * The default per-resource view for formats with no format-specific ReviewBody:
 * a flat list of labeled resources with include checkboxes.
 */
const DefaultResourceList = ({
  labeled,
  selection,
  onSelectionChange,
}: {
  readonly labeled: readonly LabeledResource<FhirResource>[]
  readonly selection: Review.Selection<FhirResource>
  readonly onSelectionChange: (selection: Review.Selection<FhirResource>) => void
}): JSX.Element => (
  <ul className={styles.resourceList}>
    {labeled.map((entry) => {
      const included = Review.isResourceIncluded(selection, entry.key)
      return (
        <li key={entry.key} className={styles.resourceRow}>
          <label className={styles.resourceLabel}>
            <input
              type="checkbox"
              checked={included}
              aria-label={`Include ${entry.title}`}
              onChange={() => onSelectionChange(Review.toggleResource(selection, entry.key))}
            />
            <span className={included ? undefined : styles.resourceExcluded}>{entry.title}</span>
          </label>
        </li>
      )
    })}
  </ul>
)

/**
 * The rendered body for one read file — its format's `ReviewBody`, or the
 * default list when that format has none. Switches on the tagged review's
 * `format`, so each branch works with a K-narrowed review and the
 * matching `ReviewBody` component: no cast.
 */
const ReadFileBody = ({
  fileId,
  tagged,
  labeled,
  selection,
  reviewBodyRegistry,
  onReviewChange,
  onSelectionChange,
}: {
  readonly fileId: string
  readonly tagged: FormatReview
  readonly labeled: readonly LabeledResource<FhirResource>[]
  readonly selection: Review.Selection<FhirResource>
  readonly reviewBodyRegistry: ReviewBodyRegistry
  readonly onReviewChange: (fileId: string, tagged: FormatReview) => void
  readonly onSelectionChange: (selection: Review.Selection<FhirResource>) => void
}): JSX.Element => {
  if (tagged.format === 'har') {
    const Body = reviewBodyRegistry.har.ReviewBody
    if (Body === null) {
      return (
        <DefaultResourceList
          labeled={labeled}
          selection={selection}
          onSelectionChange={onSelectionChange}
        />
      )
    }
    return (
      <Body
        review={tagged.review}
        labeled={labeled}
        selection={selection}
        onReviewChange={(review) => onReviewChange(fileId, { format: 'har', review })}
        onSelectionChange={onSelectionChange}
      />
    )
  }
  // tagged.format === 'lifelabs-pdf' — TS narrows tagged.review to LifeLabsPdfReviewState here.
  const Body = reviewBodyRegistry['lifelabs-pdf'].ReviewBody
  if (Body === null) {
    return (
      <DefaultResourceList
        labeled={labeled}
        selection={selection}
        onSelectionChange={onSelectionChange}
      />
    )
  }
  return (
    <Body
      review={tagged.review}
      labeled={labeled}
      selection={selection}
      onReviewChange={(review) => onReviewChange(fileId, { format: 'lifelabs-pdf', review })}
      onSelectionChange={onSelectionChange}
    />
  )
}

/** One file's whole outcome, under its own name — the unit the batch is built from. */
const FileSection = ({
  file,
  reviewBodyRegistry,
  reviewFor,
  labeledFor,
  selectionFor,
  onReviewChange,
  onSelectionChange,
}: Pick<
  PreviewPanelProps,
  | 'reviewBodyRegistry'
  | 'reviewFor'
  | 'labeledFor'
  | 'selectionFor'
  | 'onReviewChange'
  | 'onSelectionChange'
> & {
  readonly file: FileReadOutcome
}): JSX.Element => {
  const body = ((): JSX.Element | null => {
    if (file._tag === 'unreadable') {
      return (
        <p role="alert" className={styles.emptyMessage}>
          {UNREADABLE_FILE_MESSAGE}
        </p>
      )
    }
    if (file._tag === 'unrecognized') {
      return (
        <p role="alert" className={styles.emptyMessage}>
          {UNRECOGNIZED_FILE_MESSAGE}
        </p>
      )
    }
    return (
      <ReadFileBody
        fileId={file.id}
        tagged={reviewFor(file)}
        labeled={labeledFor(file.id)}
        selection={selectionFor(file.id)}
        reviewBodyRegistry={reviewBodyRegistry}
        onReviewChange={onReviewChange}
        onSelectionChange={(selection) => onSelectionChange(file.id, selection)}
      />
    )
  })()
  return (
    <section className={styles.fileSection} aria-label={file.picked.fileName}>
      <h3 className={styles.fileHeading}>{file.picked.fileName}</h3>
      {body}
    </section>
  )
}

/** The single action row for the whole batch: confirm (when anything is chosen) and cancel. */
const PreviewActions = ({
  writableCount,
  excludedCount,
  onConfirm,
  onCancel,
  confirming,
}: {
  readonly writableCount: number
  readonly excludedCount: number
  readonly onConfirm: () => void
  readonly onCancel: () => void
  readonly confirming: boolean
}): JSX.Element => (
  <div className={styles.actions}>
    <button type="button" className={styles.cancel} onClick={onCancel} disabled={confirming}>
      Cancel
    </button>
    {writableCount > 0 && (
      <button type="button" className={styles.confirm} onClick={onConfirm} disabled={confirming}>
        {confirmLabel(writableCount, excludedCount, confirming)}
      </button>
    )}
  </div>
)

/**
 * The preview surface. Renders every picked file's interactive review — via
 * its own format's ReviewBody or the default list — and, when at least one
 * has an included resource, the single confirm action that opts into
 * writing the whole batch.
 */
const PreviewPanel = ({
  files,
  reviewBodyRegistry,
  reviewFor,
  labeledFor,
  selectionFor,
  onReviewChange,
  onSelectionChange,
  onConfirm,
  onCancel,
  confirming,
}: PreviewPanelProps): JSX.Element => {
  const { writableCount, excludedCount } = useMemo(() => {
    let included = 0
    let excluded = 0
    for (const file of files) {
      if (file._tag !== 'read') continue
      const labeled = labeledFor(file.id)
      const selection = selectionFor(file.id)
      included += Review.includedCount(labeled, selection)
      excluded += Review.excludedCount(labeled, selection)
    }
    return { writableCount: included, excludedCount: excluded }
  }, [files, labeledFor, selectionFor])
  return (
    <section aria-label="Import preview" className={styles.panel}>
      <h2 className={styles.heading}>
        {writableCount > 0 ? PREVIEW_HEADING : NOTHING_TO_IMPORT_HEADING}
      </h2>
      {files.length > 1 && writableCount > 0 && (
        <p role="status" className={styles.batchSummary}>
          {`${writableCount} ${plural(writableCount, 'resource')} across ${files.length} files`}
        </p>
      )}
      <div className={styles.fileSections}>
        {files.map((file) => (
          <FileSection
            key={file.id}
            file={file}
            reviewBodyRegistry={reviewBodyRegistry}
            reviewFor={reviewFor}
            labeledFor={labeledFor}
            selectionFor={selectionFor}
            onReviewChange={onReviewChange}
            onSelectionChange={onSelectionChange}
          />
        ))}
      </div>
      <PreviewActions
        writableCount={writableCount}
        excludedCount={excludedCount}
        onConfirm={onConfirm}
        onCancel={onCancel}
        confirming={confirming}
      />
    </section>
  )
}

export {
  NOTHING_TO_IMPORT_HEADING,
  PREVIEW_HEADING,
  PreviewPanel,
  type PreviewPanelProps,
  type ReviewBodyRegistry,
  UNREADABLE_FILE_MESSAGE,
  UNRECOGNIZED_FILE_MESSAGE,
}
