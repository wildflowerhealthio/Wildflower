import type { HttpResponseKind } from 'http-extraction-fundamentals'
import { Review } from 'importer-fundamentals'
import type { JSX } from 'react'

import type { ReviewBodyProps } from 'har-importer-react'

import type { FileReadOutcome } from './use-import-run.ts'
import styles from './preview-panel.module.css'

/**
 * The preview view: an interactive per-URL review of exactly what the import
 * would write, shown before anything touches the server, so confirming is an
 * informed, opt-in act.
 *
 * @remarks
 * A pick is a *batch* of one or more files, each read independently, and this
 * panel renders them together under one confirm. Every file's outcome renders
 * honestly and distinctly:
 *
 * - **A read file** renders the format's interactive `ReviewBody` — a per-URL
 *   list of the archive's recognized responses, each with a picker among the
 *   kinds that matched (defaulting to the top-specificity one), a whole-import
 *   kind toggle, and a collapsible section for the responses nothing recognized.
 * - **An unreadable file** — one that did not parse at all — is reported against
 *   its own name rather than sinking the batch.
 *
 * The single confirm action appears only when at least one file has a chosen
 * response to write, and it opts into writing *every* chosen response across the
 * batch; the other state offers only a way back. Confirming here does not write —
 * it calls `onConfirm`, and the confirm step (upload-then-persist, per file, only
 * the chosen responses) is what writes.
 *
 * @packageDocumentation
 */

/** Props for {@link PreviewPanel}. */
interface PreviewPanelProps {
  /** Every picked file's read outcome, rendered together under one confirm. */
  readonly files: readonly FileReadOutcome[]
  /** The format's response-kind pool (the descriptor's `pool`), for recognition + the review. */
  readonly pool: readonly HttpResponseKind.HttpResponseKind<unknown>[]
  /** The format's interactive review body, rendered per read file. */
  readonly ReviewBody: (props: ReviewBodyProps) => JSX.Element
  /** The reviewed selection for a file (defaults to `Review.initial(pool)` before any edit). */
  readonly selectionFor: (fileId: string) => Review.Selection
  /** Called when a file's review changes its selection. */
  readonly onSelectionChange: (fileId: string, selection: Review.Selection) => void
  /**
   * Called when the user confirms the batch. Fires only when at least one file
   * has a chosen response to write; the panel gates the affordance, so a caller
   * can treat this as "the user opted in to writing the batch".
   */
  readonly onConfirm: () => void
  /** Called when the user discards the preview without writing. */
  readonly onCancel: () => void
  /** Whether a confirmed import is currently running, to disable the action. */
  readonly confirming: boolean
}

/** Heading for a batch with nothing chosen — no file was recognized, or all were opted out. */
const NOTHING_TO_IMPORT_HEADING = 'Nothing to import'

/** Heading for a batch that has responses chosen to write. */
const PREVIEW_HEADING = 'Ready to import'

/** Message for a file that did not parse as a HAR at all. */
const UNREADABLE_FILE_MESSAGE = 'This file could not be read as a HAR.'

/** `noun` singular when `count === 1`, else its `-s` plural. */
const plural = (count: number, noun: string): string => (count === 1 ? noun : `${noun}s`)

/** How many responses one read file has currently chosen to import. */
const chosenCountOf = (
  file: Extract<FileReadOutcome, { readonly _tag: 'read' }>,
  pool: PreviewPanelProps['pool'],
  selectionFor: PreviewPanelProps['selectionFor']
): number => Review.chosenCount(Review.recognize(pool, file.responses), selectionFor(file.id))

/** The responses a batch of read files has currently chosen, summed across them. */
const writableCountOf = (
  files: readonly FileReadOutcome[],
  pool: PreviewPanelProps['pool'],
  selectionFor: PreviewPanelProps['selectionFor']
): number =>
  files.reduce(
    (total, file) =>
      file._tag === 'read' ? total + chosenCountOf(file, pool, selectionFor) : total,
    0
  )

/** One file's whole outcome, under its own name — the unit the batch is built from. */
const FileSection = ({
  file,
  pool,
  ReviewBody,
  selectionFor,
  onSelectionChange,
}: {
  readonly file: FileReadOutcome
  readonly pool: PreviewPanelProps['pool']
  readonly ReviewBody: PreviewPanelProps['ReviewBody']
  readonly selectionFor: PreviewPanelProps['selectionFor']
  readonly onSelectionChange: PreviewPanelProps['onSelectionChange']
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
        pool={pool}
        initialSelection={selectionFor(file.id)}
        onChange={(selection) => onSelectionChange(file.id, selection)}
      />
    )}
  </section>
)

/** The single action row for the whole batch: confirm (when anything is chosen) and cancel. */
const PreviewActions = ({
  writableCount,
  onConfirm,
  onCancel,
  confirming,
}: {
  readonly writableCount: number
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
        {confirming ? 'Importing…' : `Import ${writableCount} ${plural(writableCount, 'response')}`}
      </button>
    )}
  </div>
)

/**
 * The preview surface. Renders every picked file's interactive review and, when
 * at least one has a chosen response, the single confirm action that opts into
 * writing the whole batch.
 */
const PreviewPanel = ({
  files,
  pool,
  ReviewBody,
  selectionFor,
  onSelectionChange,
  onConfirm,
  onCancel,
  confirming,
}: PreviewPanelProps): JSX.Element => {
  const writableCount = writableCountOf(files, pool, selectionFor)
  return (
    <section aria-label="Import preview" className={styles.panel}>
      <h2 className={styles.heading}>
        {writableCount > 0 ? PREVIEW_HEADING : NOTHING_TO_IMPORT_HEADING}
      </h2>
      {files.length > 1 && writableCount > 0 && (
        <p role="status" className={styles.batchSummary}>
          {`${writableCount} ${plural(writableCount, 'response')} across ${files.length} files`}
        </p>
      )}
      <div className={styles.fileSections}>
        {files.map((file) => (
          <FileSection
            key={file.id}
            file={file}
            pool={pool}
            ReviewBody={ReviewBody}
            selectionFor={selectionFor}
            onSelectionChange={onSelectionChange}
          />
        ))}
      </div>
      <PreviewActions
        writableCount={writableCount}
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
