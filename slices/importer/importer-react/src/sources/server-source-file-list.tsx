import { useQuery } from '@tanstack/react-query'
import { DateTime, Match } from 'effect'
import { useRunAuthed } from 'fhir-r4-react'
import type { PickedFile } from 'importer-fundamentals'
import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { Dialog } from 'react-tundraish'

import { DicomFilePreview } from 'dicom-importer-react'
import { SOURCE_FILES_QUERY_KEY } from '../queries/keys.ts'
import {
  type SourceFileRow,
  fetchSourceFile,
  useSmartSourceFilesQuery,
} from '../queries/source-files.ts'
import { formatRegistry } from '../registry.ts'
import styles from './server-source-file-list.module.css'

/**
 * Uploaded source files on the device's own FHIR server, as a pick source: one
 * flat list of rows across every registered format (HAR, LifeLabs PDF, DICOM),
 * paged as the reader scrolls. Each row carries a selection control and an
 * explicit **Preview** action; the selection is handed on together by the one
 * **Use selected as source** button.
 *
 * @remarks
 * Extracted from {@link SourcePicker} so a host outside this slice — the
 * anonymizer shell's `serverSource` slot — can offer the same server picks
 * without importing the whole picker. Reads only: the list is a search, a
 * preview is a `DocumentReference` GET plus a bytes render, a "use" is the
 * same GET plus the file's own name and bytes; nothing here writes.
 *
 * The list decides nothing about what one import *is* — and groups nothing. A
 * selection is handed on as one list of files, and the format's decode is what
 * says which of them belong together.
 *
 * @packageDocumentation
 */

/** How a `null` upload instant reads in a row. */
const UNDATED_LABEL = 'Upload date unknown'

/** How a source file with no title reads in a row. */
const UNTITLED_LABEL = 'Untitled source file'

/** The error shown when a chosen server source file cannot be read back. */
const SERVER_READ_ERROR = 'That source file could not be read from the server.'

/**
 * The `name` the radio inputs share when the host takes exactly one file.
 *
 * @remarks
 * One name across the rows is what makes them one group, so the browser's own
 * radio semantics — arrow-key roving, one checked member — are what a reader
 * gets, rather than a checkbox list that silently unticks its neighbours.
 */
const SINGLE_PICK_GROUP = 'server-source-file'

/**
 * The cap at which a JSON source file stops rendering inline in the preview
 * modal and falls back to a "download raw" link. Multi-megabyte HARs jank
 * the tab if they render whole; capped at 5 MiB, a giant source file still
 * stays inspectable through the download.
 */
const JSON_PREVIEW_SIZE_LIMIT = 5 * 1024 * 1024

/** Props for {@link ServerSourceFileList}. */
interface ServerSourceFileListProps {
  /** Called with the fetched files once the selected rows resolve. */
  readonly onPick: (picked: readonly PickedFile.NamedBytes[]) => void
  /**
   * How many rows may be selected at once. Left out, there is no cap.
   *
   * @remarks
   * `1` is a host with nowhere to put a twelve-file pick — the anonymizer's
   * `serverSource` slot. It renders the rows as radios, so selecting one
   * deselects every other, and names the action **Use as source**. Any other
   * cap simply disables the remaining rows' checkboxes once it is reached.
   */
  readonly maxPicks?: number | undefined
}

/** Props for {@link SourceFileRowItem}. */
interface SourceFileRowItemProps {
  readonly row: SourceFileRow
  readonly isSelected: boolean
  /** Whether the host takes exactly one file, which the row renders as a radio. */
  readonly isSingle: boolean
  /** Whether the cap is reached and this row is not one of the selected. */
  readonly isCapped: boolean
  readonly onPreview: (row: SourceFileRow) => void
  readonly onToggle: (row: SourceFileRow) => void
}

/**
 * One source file: its name, the resource it is a source of when it names one,
 * its date, its selection control, and its Preview action.
 */
const SourceFileRowItem = ({
  row,
  isSelected,
  isSingle,
  isCapped,
  onPreview,
  onToggle,
}: SourceFileRowItemProps): JSX.Element => {
  const title = row.title ?? UNTITLED_LABEL
  return (
    <li className={styles.archiveRow}>
      <div className={styles.archiveMeta}>
        <input
          type={isSingle ? 'radio' : 'checkbox'}
          {...(isSingle ? { name: SINGLE_PICK_GROUP } : {})}
          className={styles.archiveSelect}
          checked={isSelected}
          disabled={isCapped}
          aria-label={`Select ${title}`}
          onChange={() => {
            onToggle(row)
          }}
        />
        <span className={styles.archiveTitle}>{title}</span>
        {row.related !== null && (
          <span className={styles.archiveRelated}>source of {row.related}</span>
        )}
        <span className={styles.archiveDate}>
          {row.lastUpdated === null ? UNDATED_LABEL : DateTime.formatIsoDate(row.lastUpdated)}
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
      </div>
    </li>
  )
}

/** Props for {@link SourceFileListContent}. */
interface SourceFileListContentProps {
  readonly isError: boolean
  readonly isPending: boolean
  readonly rows: readonly SourceFileRow[]
  readonly isSingle: boolean
  readonly selected: ReadonlySet<string>
  readonly isCapped: boolean
  readonly onPreview: (row: SourceFileRow) => void
  readonly onToggle: (row: SourceFileRow) => void
}

/** The inner list content, rendered via Match over the query state. */
const SourceFileListContent = ({
  isError,
  isPending,
  rows,
  isSingle,
  selected,
  isCapped,
  onPreview,
  onToggle,
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
        {rows.map((row) => (
          <SourceFileRowItem
            key={row.id}
            row={row}
            isSelected={selected.has(row.id)}
            isSingle={isSingle}
            isCapped={isCapped && !selected.has(row.id)}
            onPreview={onPreview}
            onToggle={onToggle}
          />
        ))}
      </ul>
    ))
  )

/**
 * The uploaded-source-files list: a flat, multi-selectable list with an
 * explicit **Preview** per row, one action that takes the selection, and a
 * bottom sentinel that pages the rest in as it scrolls into view.
 */
const ServerSourceFileList = ({ onPick, maxPicks }: ServerSourceFileListProps): JSX.Element => {
  const runAuthed = useRunAuthed()
  const sourceFiles = useSmartSourceFilesQuery()
  const [error, setError] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState<SourceFileRow | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())

  const rows = sourceFiles.data?.pages.flatMap((page) => page.sourceFiles) ?? []
  const isSingle = maxPicks === 1
  // A cap of one is not a cap the rows enforce by going dead: the radios
  // replace one another, so every row stays selectable.
  const isCapped = !isSingle && maxPicks !== undefined && selected.size >= maxPicks

  // Auto-load the next page when the bottom sentinel scrolls into view. The
  // effect only builds an observer while there is a next page, so a
  // fully-loaded list never touches `IntersectionObserver`.
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = sourceFiles
  useEffect(() => {
    const node = sentinelRef.current
    if (node === null || !hasNextPage) return undefined
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting) && !isFetchingNextPage) {
        void fetchNextPage()
      }
    })
    observer.observe(node)
    return () => {
      observer.disconnect()
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])

  // The selected rows are fetched together and handed on as one list, so the
  // decode sees every file the reviewer selected — and groups them itself.
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

  // Selecting under a cap of one replaces the selection rather than adding to
  // it — the radio behaviour the rows are rendered with.
  const toggleRow = (row: SourceFileRow): void => {
    setSelected((current) => {
      if (current.has(row.id)) {
        const next = new Set(current)
        next.delete(row.id)
        return next
      }
      if (isSingle) return new Set([row.id])
      if (maxPicks !== undefined && current.size >= maxPicks) return current
      return new Set(current).add(row.id)
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
        isSingle={isSingle}
        selected={selected}
        isCapped={isCapped}
        onPreview={(row) => {
          setPreviewing(row)
        }}
        onToggle={toggleRow}
      />
      {rows.length > 0 && (
        <button
          type="button"
          className={`${styles.actionButton} ${styles.pickAction} ${styles.pickSelected}`}
          disabled={selected.size === 0}
          onClick={() => {
            void pickAsSource(rows.filter((row) => selected.has(row.id)))
          }}
        >
          {isSingle ? 'Use as source' : 'Use selected as source'}
        </button>
      )}
      {isFetchingNextPage && (
        <p role="status" className={styles.empty}>
          Loading more…
        </p>
      )}
      {hasNextPage && <div ref={sentinelRef} aria-hidden="true" />}
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
    queryFn: () => fetchSourceFile(runAuthed, row),
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
  UNDATED_LABEL,
  UNTITLED_LABEL,
}
