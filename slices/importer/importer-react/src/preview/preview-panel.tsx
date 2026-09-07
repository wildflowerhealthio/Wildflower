import type { HttpResponseKind, SourceDescriptor } from 'http-extraction-fundamentals'
import { Review } from 'importer-fundamentals'
import { type JSX, useMemo } from 'react'

import type { ReviewBodyProps } from 'har-importer-react'

import type { FileReadOutcome } from './use-import-run.ts'
import styles from './preview-panel.module.css'

/**
 * The preview view: an interactive per-URL, per-resource review of exactly what
 * the import would write, shown before anything touches the server, so
 * confirming is an informed, opt-in act.
 *
 * @remarks
 * A pick is a *batch* of one or more files, each read independently and
 * rendered together under one confirm: a read file gets the format's
 * interactive `ReviewBody`, an unreadable one is reported against its own name
 * rather than sinking the batch. Parse runs at preview: each read file's
 * responses are parsed through the reviewer's current picks so the review lists
 * the actual resources, keyed for stable per-resource opt-outs. The confirm
 * appears only when at least one resource is included, and it does not write —
 * it calls `onConfirm`; the confirm step writes exactly the reviewed objects.
 *
 * @packageDocumentation
 */

/** One previewed response — the parse outcome plus every resource's stable key. */
type Preview = Review.PreviewedResponse<HttpResponseKind.HttpResponseKind<unknown>, unknown>

/** Props for {@link PreviewPanel}. */
interface PreviewPanelProps {
  /** Every picked file's read outcome, rendered together under one confirm. */
  readonly files: readonly FileReadOutcome[]
  /**
   * The format's sources (the descriptor's `sources`): the review groups its
   * include toggles by these, and recognition runs against their flattened
   * kinds.
   */
  readonly sources: readonly SourceDescriptor.SourceDescriptor<unknown>[]
  /** The format's interactive review body, rendered per read file. */
  readonly ReviewBody: (props: ReviewBodyProps) => JSX.Element
  /** The reviewed selection for a file (defaults to `Review.initial(pool)` before any edit). */
  readonly selectionFor: (fileId: string) => Review.Selection
  /** Called when a file's review changes its selection. */
  readonly onSelectionChange: (fileId: string, selection: Review.Selection) => void
  /**
   * The previews for a file — the parse outcomes the shell computed under the
   * current selection. Reused by the confirm step so it never re-parses.
   */
  readonly previewFor: (fileId: string) => readonly Preview[]
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

/** Message for a file that did not parse as a HAR at all. */
const UNREADABLE_FILE_MESSAGE = 'This file could not be read as a HAR.'

/** `noun` singular when `count === 1`, else its `-s` plural. */
const plural = (count: number, noun: string): string => (count === 1 ? noun : `${noun}s`)

/** The confirm button's label, factored out so the render stays a single expression. */
const confirmLabel = (writable: number, excluded: number, confirming: boolean): string => {
  if (confirming) return 'Importing…'
  const base = `Import ${writable} ${plural(writable, 'resource')}`
  return excluded > 0 ? `${base} (${excluded} excluded)` : base
}

/** One file's whole outcome, under its own name — the unit the batch is built from. */
const FileSection = ({
  file,
  sources,
  ReviewBody,
  selectionFor,
  onSelectionChange,
  previewFor,
}: {
  readonly file: FileReadOutcome
  readonly sources: PreviewPanelProps['sources']
  readonly ReviewBody: PreviewPanelProps['ReviewBody']
  readonly selectionFor: PreviewPanelProps['selectionFor']
  readonly onSelectionChange: PreviewPanelProps['onSelectionChange']
  readonly previewFor: PreviewPanelProps['previewFor']
}): JSX.Element => (
  <section className={styles.fileSection} aria-label={file.picked.fileName}>
    <h3 className={styles.fileHeading}>{file.picked.fileName}</h3>
    {file._tag === 'unreadable' ? (
      <p role="alert" className={styles.emptyMessage}>
        {UNREADABLE_FILE_MESSAGE}
      </p>
    ) : (
      <ReviewBody
        responses={file.responses}
        sources={sources}
        previews={previewFor(file.id)}
        selection={selectionFor(file.id)}
        onChange={(selection) => onSelectionChange(file.id, selection)}
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
const PreviewPanel = ({
  files,
  sources,
  ReviewBody,
  selectionFor,
  onSelectionChange,
  previewFor,
  onConfirm,
  onCancel,
  confirming,
}: PreviewPanelProps): JSX.Element => {
  // The included/excluded aggregates read straight off the shell-supplied
  // previews so the button count and each resource row can never disagree.
  const { writableCount, excludedCount } = useMemo(() => {
    let included = 0
    let excluded = 0
    for (const file of files) {
      if (file._tag !== 'read') continue
      const previews = previewFor(file.id)
      const selection = selectionFor(file.id)
      included += Review.includedCount(previews, selection)
      excluded += Review.excludedCount(previews, selection)
    }
    return { writableCount: included, excludedCount: excluded }
  }, [files, previewFor, selectionFor])
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
            sources={sources}
            ReviewBody={ReviewBody}
            selectionFor={selectionFor}
            onSelectionChange={onSelectionChange}
            previewFor={previewFor}
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
