import type { FhirResource } from 'fhir-r4/resources'
import type { LabeledResource } from 'importer-fundamentals'
import { Review } from 'importer-fundamentals'
import { type JSX, useMemo } from 'react'

import type { FileReadOutcome } from './use-import-run.ts'
import styles from './preview-panel.module.css'

/**
 * The preview view: an interactive per-resource review of exactly what
 * the import would write, shown before anything touches the server, so
 * confirming is an informed, opt-in act.
 *
 * @remarks
 * A pick is a *batch* of one or more files, each read independently and
 * rendered together under one confirm: a read file gets the format's
 * interactive `ReviewBody` (or a default per-resource list when the format
 * has none), an unreadable one is reported against its own name rather than
 * sinking the batch. The confirm appears only when at least one resource is
 * included, and it does not write — it calls `onConfirm`; the confirm step
 * writes exactly the reviewed objects.
 *
 * @packageDocumentation
 */

/** Props for {@link PreviewPanel}. */
interface PreviewPanelProps<TReview = unknown> {
  /** Every picked file's read outcome, rendered together under one confirm. */
  readonly files: readonly FileReadOutcome[]
  /**
   * The format-specific review body, when the format has routing decisions
   * beyond the general per-resource selection. `null` when the default
   * per-resource list suffices.
   */
  readonly ReviewBody:
    | ((props: {
        readonly review: TReview
        readonly labeled: readonly LabeledResource<FhirResource>[]
        readonly selection: Review.Selection<FhirResource>
        readonly onReviewChange: (review: TReview) => void
        readonly onSelectionChange: (selection: Review.Selection<FhirResource>) => void
      }) => JSX.Element)
    | null
  /** The opaque review state for a file. */
  readonly reviewFor: (fileId: string) => TReview
  /** The resolved labeled resources for a file. */
  readonly labeledFor: (fileId: string) => readonly LabeledResource<FhirResource>[]
  /** The reviewed selection for a file (defaults to `Review.initial()` before any edit). */
  readonly selectionFor: (fileId: string) => Review.Selection<FhirResource>
  /** Called when a format-specific ReviewBody changes the review state. */
  readonly onReviewChange: (fileId: string, review: TReview) => void
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

/** One file's whole outcome, under its own name — the unit the batch is built from. */
const FileSection = <TReview,>({
  file,
  ReviewBody,
  reviewFor,
  labeledFor,
  selectionFor,
  onReviewChange,
  onSelectionChange,
}: Pick<
  PreviewPanelProps<TReview>,
  | 'ReviewBody'
  | 'reviewFor'
  | 'labeledFor'
  | 'selectionFor'
  | 'onReviewChange'
  | 'onSelectionChange'
> & {
  readonly file: FileReadOutcome
}): JSX.Element => (
  <section className={styles.fileSection} aria-label={file.picked.fileName}>
    <h3 className={styles.fileHeading}>{file.picked.fileName}</h3>
    {file._tag === 'unreadable' ? (
      <p role="alert" className={styles.emptyMessage}>
        {UNREADABLE_FILE_MESSAGE}
      </p>
    ) : ReviewBody !== null ? (
      <ReviewBody
        review={reviewFor(file.id)}
        labeled={labeledFor(file.id)}
        selection={selectionFor(file.id)}
        onReviewChange={(review) => onReviewChange(file.id, review)}
        onSelectionChange={(selection) => onSelectionChange(file.id, selection)}
      />
    ) : (
      <DefaultResourceList
        labeled={labeledFor(file.id)}
        selection={selectionFor(file.id)}
        onSelectionChange={(selection) => onSelectionChange(file.id, selection)}
      />
    )}
  </section>
)

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
 * The preview surface. Renders every picked file's interactive review and, when
 * at least one has an included resource, the single confirm action that opts
 * into writing the whole batch.
 */
const PreviewPanel = <TReview,>({
  files,
  ReviewBody,
  reviewFor,
  labeledFor,
  selectionFor,
  onReviewChange,
  onSelectionChange,
  onConfirm,
  onCancel,
  confirming,
}: PreviewPanelProps<TReview>): JSX.Element => {
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
            ReviewBody={ReviewBody}
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
  UNREADABLE_FILE_MESSAGE,
}
