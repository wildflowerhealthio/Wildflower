import { useQuery } from '@tanstack/react-query'
import { DateTime, Match } from 'effect'
import { useRunAuthed } from 'fhir-r4-react'
import type { PickedFile } from 'importer-fundamentals'
import { useEffect, useMemo, useState, type JSX } from 'react'
import { Dialog } from 'react-tundraish'

import { DicomFilePreview } from 'dicom-importer-react'
import { SectionToggle } from '../preview/section-toggle.tsx'
import { SOURCE_FILES_QUERY_KEY } from '../queries/keys.ts'
import {
  type SourceFileRow,
  type SourceFileSection,
  UNTITLED_SOURCE_FILE,
  fetchSourceFile,
  fetchSourceFileContents,
  sourceFileSections,
  useSmartSourceFilesQuery,
} from '../queries/source-files.ts'
import { formatRegistry } from '../registry.ts'
import styles from './server-source-file-list.module.css'

/**
 * Uploaded source files on the device's own FHIR server, as a pick source:
 * sections of rows across every registered format (HAR, LifeLabs PDF, DICOM),
 * paged by the bundle's next link. Each row carries an explicit **Preview**
 * action that opens a raw-contents modal; how one is picked depends on the
 * host's `mode`.
 *
 * @remarks
 * Extracted from {@link SourcePicker} so a host outside this slice — the
 * anonymizer shell's `serverSource` slot — can offer the same server picks
 * without importing the whole picker. Reads only: the list is a search, a
 * preview is a `DocumentReference` GET plus a bytes render, a "use" is the
 * same GET plus a `PickedFile` synthesis; nothing here writes.
 *
 * The list decides nothing about what one import *is*: a batch pick hands
 * every selected row on as one list, and the format's decode partitions it.
 *
 * @packageDocumentation
 */

/** How a `null` upload instant reads in a row. */
const UNDATED_LABEL = 'Upload date unknown'

/** How a source file with no title reads in a row. */
const UNTITLED_LABEL = UNTITLED_SOURCE_FILE

/** The error shown when a chosen server source file cannot be read back. */
const SERVER_READ_ERROR = 'That source file could not be read from the server.'

/**
 * The cap at which a JSON source file stops rendering inline in the preview
 * modal and falls back to a "download raw" link. Multi-megabyte HARs jank
 * the tab if they render whole; capped at 5 MiB, a giant source file still
 * stays inspectable through the download.
 */
const JSON_PREVIEW_SIZE_LIMIT = 5 * 1024 * 1024

/**
 * How many source files the host consumes at once.
 *
 * @remarks
 * `batch` is the importer flow: rows are selected across the sections and
 * picked together, so a study re-imports as the one study it was.
 * `single` is a one-at-a-time flow — the anonymizer's `serverSource` slot,
 * which has nowhere to put a twelve-file pick.
 */
type SourceFileListMode = 'batch' | 'single'

/** Props for {@link ServerSourceFileList}. */
interface ServerSourceFileListProps {
  /** Called with the fetched source files once the chosen rows resolve. */
  readonly onPick: (picked: readonly PickedFile.Type[]) => void
  /** Whether the host takes a batch of files or one at a time. */
  readonly mode: SourceFileListMode
}

/** Props for {@link SourceFileListContent}. */
interface SourceFileListContentProps {
  readonly isError: boolean
  readonly isPending: boolean
  readonly rows: readonly SourceFileRow[]
  readonly mode: SourceFileListMode
  readonly selected: ReadonlySet<string>
  readonly onPreview: (row: SourceFileRow) => void
  readonly onUse: (row: SourceFileRow) => void
  readonly onSetSelected: (ids: readonly string[], included: boolean) => void
}

/** Props for {@link SourceFileRowItem}. */
interface SourceFileRowItemProps {
  readonly row: SourceFileRow
  readonly mode: SourceFileListMode
  readonly isSelected: boolean
  readonly onPreview: (row: SourceFileRow) => void
  readonly onUse: (row: SourceFileRow) => void
  readonly onSetSelected: (ids: readonly string[], included: boolean) => void
}

/**
 * One source file: its name and upload date, its Preview action, and the way
 * it is picked — a selection checkbox in `batch`, its own **Use as source**
 * action in `single`.
 */
const SourceFileRowItem = ({
  row,
  mode,
  isSelected,
  onPreview,
  onUse,
  onSetSelected,
}: SourceFileRowItemProps): JSX.Element => {
  const title = row.title ?? UNTITLED_LABEL
  return (
    <li className={styles.archiveRow}>
      <div className={styles.archiveMeta}>
        {mode === 'batch' && (
          <input
            type="checkbox"
            className={styles.archiveSelect}
            checked={isSelected}
            aria-label={`Select ${title}`}
            onChange={() => {
              onSetSelected([row.id], !isSelected)
            }}
          />
        )}
        <span className={styles.archiveTitle}>{title}</span>
        <span className={styles.archiveDate}>
          {row.creation === null ? UNDATED_LABEL : DateTime.formatIsoDate(row.creation)}
        </span>
      </div>
      <div className={styles.archiveActions}>
        <button
          type="button"
          className={styles.actionButton}
          aria-label={`Preview ${title}`}
          onClick={() => {
            onPreview(row)
          }}
        >
          Preview
        </button>
        {mode === 'single' && (
          <button
            type="button"
            className={`${styles.actionButton} ${styles.pickAction}`}
            aria-label={`Use ${title} as source`}
            onClick={() => {
              onUse(row)
            }}
          >
            Use as source
          </button>
        )}
      </div>
    </li>
  )
}

/** Props for {@link SourceFileSectionItem}. */
interface SourceFileSectionItemProps extends Omit<
  SourceFileListContentProps,
  'isError' | 'isPending' | 'rows'
> {
  readonly section: SourceFileSection
}

/**
 * One section of the list: its rows, under a heading with the shared
 * {@link SectionToggle} when it holds more than one.
 *
 * @remarks
 * A section of one is rendered as its row alone — its title is the row's own,
 * and its toggle is the row's own checkbox, so a heading would repeat both.
 */
const SourceFileSectionItem = ({
  section,
  mode,
  selected,
  onPreview,
  onUse,
  onSetSelected,
}: SourceFileSectionItemProps): JSX.Element => {
  const rows = section.rows.map((row) => (
    <SourceFileRowItem
      key={row.id}
      row={row}
      mode={mode}
      isSelected={selected.has(row.id)}
      onPreview={onPreview}
      onUse={onUse}
      onSetSelected={onSetSelected}
    />
  ))
  if (section.rows.length === 1) return <>{rows}</>
  return (
    <li className={styles.archiveSection}>
      {mode === 'batch' ? (
        <SectionToggle
          title={section.title}
          keys={section.rows.map((row) => row.id)}
          isIncluded={(id) => selected.has(id)}
          onSetIncluded={onSetSelected}
        />
      ) : (
        <div className={styles.archiveSectionHeading}>
          <span className={styles.archiveTitle}>{section.title}</span>
        </div>
      )}
      <ul className={styles.archiveList}>{rows}</ul>
    </li>
  )
}

/** The inner list content, rendered via Match over the query state. */
const SourceFileListContent = ({
  isError,
  isPending,
  rows,
  mode,
  selected,
  onPreview,
  onUse,
  onSetSelected,
}: SourceFileListContentProps): JSX.Element =>
  Match.value({ isError, isPending, empty: rows.length === 0 }).pipe(
    Match.when({ isError: true }, () => (
      <p role="alert" className={styles.error}>
        The uploaded source files could not be loaded.
      </p>
    )),
    Match.when({ isPending: true }, () => (
      <p role="status" className={styles.empty}>
        Loading uploaded source files…
      </p>
    )),
    Match.when({ empty: true }, () => (
      <p className={styles.empty}>No source files have been uploaded to the FHIR server.</p>
    )),
    Match.orElse(() => (
      <ul className={styles.archiveList}>
        {sourceFileSections(rows).map((section) => (
          <SourceFileSectionItem
            key={section.rows[0]?.id ?? section.title}
            section={section}
            mode={mode}
            selected={selected}
            onPreview={onPreview}
            onUse={onUse}
            onSetSelected={onSetSelected}
          />
        ))}
      </ul>
    ))
  )

/**
 * The uploaded-source-files list, heading and paging included. An explicit
 * **Preview** per row; a **Use selected as source** for a batch host, a
 * per-row **Use as source** for a single-file one.
 */
const ServerSourceFileList = ({ onPick, mode }: ServerSourceFileListProps): JSX.Element => {
  const runAuthed = useRunAuthed()
  const sourceFiles = useSmartSourceFilesQuery()
  const [error, setError] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState<SourceFileRow | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())

  const rows = sourceFiles.data?.pages.flatMap((page) => page.sourceFiles) ?? []

  // The chosen rows are fetched together and handed on as one pick, so the
  // decode sees every file the reviewer selected — and partitions them itself.
  const pickAsSource = async (chosen: readonly SourceFileRow[]): Promise<void> => {
    try {
      const picked = await Promise.all(chosen.map((row) => fetchSourceFile(runAuthed, row)))
      setError(null)
      setSelected(new Set())
      onPick(picked)
    } catch {
      setError(SERVER_READ_ERROR)
    }
  }

  const setRowsSelected = (ids: readonly string[], included: boolean): void => {
    setSelected((current) => {
      const next = new Set(current)
      for (const id of ids) {
        if (included) next.add(id)
        else next.delete(id)
      }
      return next
    })
  }

  return (
    <div className={styles.server}>
      <h3 className={styles.serverHeading}>Uploaded source files on the FHIR server</h3>
      {error !== null && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      <SourceFileListContent
        isError={sourceFiles.isError}
        isPending={sourceFiles.isPending}
        rows={rows}
        mode={mode}
        selected={selected}
        onPreview={(row) => {
          setPreviewing(row)
        }}
        onUse={(row) => {
          void pickAsSource([row])
        }}
        onSetSelected={setRowsSelected}
      />
      {mode === 'batch' && rows.length > 0 && (
        <button
          type="button"
          className={`${styles.actionButton} ${styles.pickAction} ${styles.pickSelected}`}
          disabled={selected.size === 0}
          onClick={() => {
            void pickAsSource(rows.filter((row) => selected.has(row.id)))
          }}
        >
          Use selected as source
        </button>
      )}
      {sourceFiles.hasNextPage && (
        <button
          type="button"
          className={styles.loadMore}
          disabled={sourceFiles.isFetchingNextPage}
          onClick={() => {
            void sourceFiles.fetchNextPage()
          }}
        >
          {sourceFiles.isFetchingNextPage ? 'Loading…' : 'Show more source files'}
        </button>
      )}
      <SourceFilePreviewDialog
        row={previewing}
        onClose={() => {
          setPreviewing(null)
        }}
      />
    </div>
  )
}

/** Props for {@link SourceFilePreviewDialog}. */
interface SourceFilePreviewDialogProps {
  /** The row being previewed, or `null` when the dialog is closed. */
  readonly row: SourceFileRow | null
  /** Called when the reviewer dismisses the dialog. */
  readonly onClose: () => void
}

/**
 * The raw-contents preview modal. Follows {@link ResourceEditor}'s pattern:
 * the {@link Dialog} wrapper stays mounted so tundraish can drive its close
 * animation, and the body only mounts while `row` is non-null — which is
 * what lets the body's fetch and blob URL creation be one-shot per open.
 */
const SourceFilePreviewDialog = ({ row, onClose }: SourceFilePreviewDialogProps): JSX.Element => (
  <Dialog open={row !== null} onClose={onClose} title="Preview source file">
    {row !== null ? <PreviewBody row={row} onClose={onClose} /> : null}
  </Dialog>
)

/**
 * The dialog body — fetches the source file through a keyed TanStack query
 * so `useQuery`'s own loading/error/data states drive the render (no
 * `setState`-in-effect), then renders the raw file itself, per the
 * format's `sourceFileContentType`.
 */
const PreviewBody = ({
  row,
  onClose,
}: {
  readonly row: SourceFileRow
  readonly onClose: () => void
}): JSX.Element => {
  const runAuthed = useRunAuthed()
  const query = useQuery({
    queryKey: [...SOURCE_FILES_QUERY_KEY, 'preview', row.format, row.id] as const,
    queryFn: () => fetchSourceFileContents(runAuthed, row),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  })

  if (query.isPending) {
    return (
      <p role="status" className={styles.previewNote}>
        Loading source file…
      </p>
    )
  }
  if (query.isError) {
    return (
      <p role="alert" className={styles.error}>
        {SERVER_READ_ERROR}
      </p>
    )
  }
  const entry = formatRegistry[row.format]
  return (
    <PreviewContents
      fileName={query.data.fileName}
      bytes={query.data.bytes}
      contentType={entry.sourceFileFormat.contentType}
      onClose={onClose}
    />
  )
}

/** Props for {@link PreviewContents}. */
interface PreviewContentsProps {
  readonly fileName: string
  readonly bytes: Uint8Array
  readonly contentType: string
  readonly onClose: () => void
}

/**
 * The format-specific preview body. When the format supplies a `FilePreview`
 * component, it renders instead of the content-type dispatch; otherwise PDF
 * renders in an iframe, JSON/HAR pretty-prints, and anything else shows a
 * binary notice with the file size.
 */
const PreviewContentBody = ({
  contentType,
  blobUrl,
  fileName,
  bytes,
}: {
  readonly contentType: string
  readonly blobUrl: string
  readonly fileName: string
  readonly bytes: Uint8Array
}): JSX.Element => {
  if (contentType === 'application/dicom')
    return <DicomFilePreview bytes={bytes} fileName={fileName} />
  if (contentType === 'application/pdf') return <PdfBody blobUrl={blobUrl} fileName={fileName} />
  if (contentType === 'application/json' || contentType === 'application/har+json') {
    return <JsonBody bytes={bytes} />
  }
  return <BinaryBody bytes={bytes} />
}

/**
 * The rendered preview body, chosen by content type: PDF as an
 * `<iframe>` from a `blob:` URL, JSON pretty-printed inside a `<pre>`
 * with a size cap and a "download raw" fallback.
 */
const PreviewContents = ({
  fileName,
  bytes,
  contentType,
  onClose,
}: PreviewContentsProps): JSX.Element => {
  const blobUrl = useBlobUrl(bytes, contentType)
  return (
    <div className={styles.preview}>
      <div className={styles.previewHeader}>
        <span className={styles.previewFileName}>{fileName}</span>
      </div>
      <PreviewContentBody
        contentType={contentType}
        blobUrl={blobUrl}
        fileName={fileName}
        bytes={bytes}
      />
      <div className={styles.previewActions}>
        <a
          className={styles.downloadLink}
          href={blobUrl}
          download={fileName}
          data-testid="preview-download"
        >
          Download raw
        </a>
        <button
          type="button"
          className={styles.actionButton}
          onClick={() => {
            onClose()
          }}
        >
          Close
        </button>
      </div>
    </div>
  )
}

/**
 * A `blob:` URL for the source file's raw bytes, revoked on unmount and
 * re-minted when the bytes or content type change.
 *
 * @remarks
 * `useMemo` mints the URL synchronously so the very first render already
 * has one — no `useState`-in-effect pattern the React lint disallows —
 * and a paired `useEffect` cleanup revokes it. `new Uint8Array(bytes)`
 * copies into a fresh ArrayBuffer-backed view, which is what `BlobPart`
 * demands (the seam itself returns `Uint8Array<ArrayBufferLike>`, which
 * is not structurally a `BlobPart`); the copy is one-shot per open and
 * the source file size is size-capped by the preview above it.
 */
const useBlobUrl = (bytes: Uint8Array, contentType: string): string => {
  const blobUrl = useMemo(
    () => URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: contentType })),
    [bytes, contentType]
  )
  useEffect(
    () => (): void => {
      URL.revokeObjectURL(blobUrl)
    },
    [blobUrl]
  )
  return blobUrl
}

/**
 * PDF preview: an `<iframe>` at a `blob:` URL for the PDF bytes. The
 * browser renders the PDF natively; no viewer library is needed.
 *
 * @remarks
 * A browser that cannot render PDFs shows the fallback text inside the
 * `<iframe>` — the "Download raw" action outside the frame is still
 * available. A host app whose Content-Security-Policy restricts
 * `frame-src` must include `blob:` for the iframe to load; the importer
 * web app has no custom CSP so the browser default applies.
 */
const PdfBody = ({
  blobUrl,
  fileName,
}: {
  readonly blobUrl: string
  readonly fileName: string
}): JSX.Element => (
  <iframe
    className={styles.previewFrame}
    src={blobUrl}
    title={`Preview of ${fileName}`}
    sandbox="allow-scripts"
    data-testid="preview-pdf-frame"
  >
    Your browser cannot display this PDF. Use "Download raw" to save it.
  </iframe>
)

/**
 * JSON preview: the file's UTF-8 text pretty-printed inside a `<pre>`.
 *
 * @remarks
 * Capped at {@link JSON_PREVIEW_SIZE_LIMIT}: above the cap, no inline
 * render — a giant HAR would jank the tab. On a parse failure (a
 * malformed HAR the reviewer wants to inspect) the raw text is shown
 * verbatim instead, since the intent of "preview" is "see what the file
 * actually holds", not "see how the parser reads it".
 */
const JsonBody = ({ bytes }: { readonly bytes: Uint8Array }): JSX.Element => {
  const rendered = useMemo(() => renderJsonPreview(bytes), [bytes])
  return Match.value(rendered).pipe(
    Match.tag('too-large', ({ sizeBytes }) => (
      <p className={styles.previewNote}>
        This source file is {formatBytesMib(sizeBytes)} — too large to preview inline. Use "Download
        raw" to inspect its contents.
      </p>
    )),
    Match.tag('rendered', ({ text }) => (
      <pre className={styles.previewText} data-testid="preview-json">
        {text}
      </pre>
    )),
    Match.exhaustive
  )
}

/**
 * Binary preview: a short notice with the file size. Non-text formats
 * (DICOM, images) cannot render inline; the "Download raw" action outside
 * this component is the inspection path.
 */
const BinaryBody = ({ bytes }: { readonly bytes: Uint8Array }): JSX.Element => (
  <p className={styles.previewNote} data-testid="preview-binary">
    Binary file ({formatBytesMib(bytes.length)}). Use "Download raw" to inspect its contents.
  </p>
)

/** Result of {@link renderJsonPreview}. */
type JsonRender =
  | { readonly _tag: 'too-large'; readonly sizeBytes: number }
  | { readonly _tag: 'rendered'; readonly text: string }

/**
 * Turn a source file's bytes into what the JSON preview body renders — the
 * pretty-printed JSON, or the raw text if it does not parse, or the
 * "too large" signal above the size cap.
 */
const renderJsonPreview = (bytes: Uint8Array): JsonRender => {
  if (bytes.length > JSON_PREVIEW_SIZE_LIMIT) {
    return { _tag: 'too-large', sizeBytes: bytes.length }
  }
  const text = new TextDecoder().decode(bytes)
  try {
    const parsed: unknown = JSON.parse(text)
    return { _tag: 'rendered', text: JSON.stringify(parsed, null, 2) }
  } catch {
    return { _tag: 'rendered', text }
  }
}

/** MiB with one decimal, for the "too large" notice. */
const formatBytesMib = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`

export {
  JSON_PREVIEW_SIZE_LIMIT,
  SERVER_READ_ERROR,
  ServerSourceFileList,
  type ServerSourceFileListProps,
  type SourceFileListMode,
  UNDATED_LABEL,
  UNTITLED_LABEL,
}
