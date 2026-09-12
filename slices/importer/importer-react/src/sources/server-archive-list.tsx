import { useQuery } from '@tanstack/react-query'
import { DateTime, Match } from 'effect'
import { useRunAuthed } from 'fhir-r4-react'
import { useEffect, useMemo, useState, type JSX } from 'react'
import { Dialog } from 'react-tundraish'

import {
  type ArchiveRow,
  fetchArchive,
  fetchArchiveContents,
  useArchivesQuery,
} from '../queries/archives.ts'
import { ARCHIVES_QUERY_KEY } from '../queries/keys.ts'
import { formatRegistry } from '../registry.ts'
import type { PickedFile } from './picked-file.ts'
import styles from './server-archive-list.module.css'

/**
 * Uploaded archives on the device's own FHIR server, as a pick source: one
 * row per archive across every registered format (HAR, LifeLabs PDF), paged
 * by the bundle's next link. Each row carries an explicit **Preview** action
 * that opens a raw-contents modal and a **Use as source** action that
 * fetches the archive back and picks it — the row itself is not clickable,
 * so the two actions are unambiguous.
 *
 * @remarks
 * Extracted from {@link SourcePicker} so a host outside this slice — the
 * anonymizer shell's `serverSource` slot — can offer the same server picks
 * without importing the whole picker. Reads only: the list is a search, a
 * preview is a `DocumentReference` GET plus a bytes render, a "use" is the
 * same GET plus a `PickedFile` synthesis; nothing here writes.
 *
 * @packageDocumentation
 */

/** How a `null` upload instant reads in a row. */
const UNDATED_LABEL = 'Upload date unknown'

/** How an archive with no title reads in a row. */
const UNTITLED_LABEL = 'Untitled archive'

/** The error shown when a chosen server archive cannot be read back. */
const SERVER_READ_ERROR = 'That archive could not be read from the server.'

/**
 * The cap at which a JSON archive stops rendering inline in the preview
 * modal and falls back to a "download raw" link. Multi-megabyte HARs jank
 * the tab if they render whole; capped at 5 MiB, a giant archive still
 * stays inspectable through the download.
 */
const JSON_PREVIEW_SIZE_LIMIT = 5 * 1024 * 1024

/** Props for {@link ServerArchiveList}. */
interface ServerArchiveListProps {
  /** Called with the fetched archive once a selected row resolves. */
  readonly onPick: (picked: PickedFile) => void
}

/** Props for {@link ArchiveListContent}. */
interface ArchiveListContentProps {
  readonly isError: boolean
  readonly isPending: boolean
  readonly rows: readonly ArchiveRow[]
  readonly onPreview: (row: ArchiveRow) => void
  readonly onUse: (row: ArchiveRow) => void
}

/** The inner list content, rendered via Match over the query state. */
const ArchiveListContent = ({
  isError,
  isPending,
  rows,
  onPreview,
  onUse,
}: ArchiveListContentProps): JSX.Element =>
  Match.value({ isError, isPending, empty: rows.length === 0 }).pipe(
    Match.when({ isError: true }, () => (
      <p role="alert" className={styles.error}>
        The uploaded archives could not be loaded.
      </p>
    )),
    Match.when({ isPending: true }, () => (
      <p role="status" className={styles.empty}>
        Loading uploaded archives…
      </p>
    )),
    Match.when({ empty: true }, () => (
      <p className={styles.empty}>No archives have been uploaded to the FHIR server.</p>
    )),
    Match.orElse(() => (
      <ul className={styles.archiveList}>
        {rows.map((row) => {
          const title = row.title ?? UNTITLED_LABEL
          return (
            <li key={row.id} className={styles.archiveRow}>
              <div className={styles.archiveMeta}>
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
              </div>
            </li>
          )
        })}
      </ul>
    ))
  )

/**
 * The uploaded-archives list, heading and paging included. Explicit
 * **Preview** / **Use as source** actions per row.
 */
const ServerArchiveList = ({ onPick }: ServerArchiveListProps): JSX.Element => {
  const runAuthed = useRunAuthed()
  const archives = useArchivesQuery()
  const [error, setError] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState<ArchiveRow | null>(null)

  const pickAsSource = async (row: ArchiveRow): Promise<void> => {
    try {
      const picked = await fetchArchive(runAuthed, row)
      setError(null)
      onPick(picked)
    } catch {
      setError(SERVER_READ_ERROR)
    }
  }

  const rows = archives.data?.pages.flatMap((page) => page.archives) ?? []

  return (
    <div className={styles.server}>
      <h3 className={styles.serverHeading}>Uploaded archives on the FHIR server</h3>
      {error !== null && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      <ArchiveListContent
        isError={archives.isError}
        isPending={archives.isPending}
        rows={rows}
        onPreview={(row) => {
          setPreviewing(row)
        }}
        onUse={(row) => {
          void pickAsSource(row)
        }}
      />
      {archives.hasNextPage && (
        <button
          type="button"
          className={styles.loadMore}
          disabled={archives.isFetchingNextPage}
          onClick={() => {
            void archives.fetchNextPage()
          }}
        >
          {archives.isFetchingNextPage ? 'Loading…' : 'Show more archives'}
        </button>
      )}
      <ArchivePreviewDialog
        row={previewing}
        onClose={() => {
          setPreviewing(null)
        }}
      />
    </div>
  )
}

/** Props for {@link ArchivePreviewDialog}. */
interface ArchivePreviewDialogProps {
  /** The row being previewed, or `null` when the dialog is closed. */
  readonly row: ArchiveRow | null
  /** Called when the reviewer dismisses the dialog. */
  readonly onClose: () => void
}

/**
 * The raw-contents preview modal. Follows {@link ResourceEditor}'s pattern:
 * the {@link Dialog} wrapper stays mounted so tundraish can drive its close
 * animation, and the body only mounts while `row` is non-null — which is
 * what lets the body's fetch and blob URL creation be one-shot per open.
 */
const ArchivePreviewDialog = ({ row, onClose }: ArchivePreviewDialogProps): JSX.Element => (
  <Dialog open={row !== null} onClose={onClose} title="Preview archive">
    {row !== null ? <PreviewBody row={row} onClose={onClose} /> : null}
  </Dialog>
)

/**
 * The dialog body — fetches the archive through a keyed TanStack query
 * so `useQuery`'s own loading/error/data states drive the render (no
 * `setState`-in-effect), then renders the raw file itself, per the
 * format's `archiveContentType`.
 */
const PreviewBody = ({
  row,
  onClose,
}: {
  readonly row: ArchiveRow
  readonly onClose: () => void
}): JSX.Element => {
  const runAuthed = useRunAuthed()
  const query = useQuery({
    queryKey: [...ARCHIVES_QUERY_KEY, 'preview', row.format, row.id] as const,
    queryFn: () => fetchArchiveContents(runAuthed, row),
    // The preview modal is short-lived; a stale cache from a previous open
    // would show yesterday's bytes for the same id if the archive was
    // replaced server-side. Refetch on every open, no long GC.
    staleTime: 0,
    gcTime: 0,
    retry: false,
  })

  if (query.isPending) {
    return (
      <p role="status" className={styles.previewNote}>
        Loading archive…
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
  return (
    <PreviewContents
      fileName={query.data.fileName}
      bytes={query.data.bytes}
      contentType={formatRegistry[row.format].archiveContentType}
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
      {contentType === 'application/pdf' ? (
        <PdfBody blobUrl={blobUrl} fileName={fileName} />
      ) : (
        <JsonBody bytes={bytes} />
      )}
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
 * A `blob:` URL for the archive's raw bytes, revoked on unmount and
 * re-minted when the bytes or content type change.
 *
 * @remarks
 * `useMemo` mints the URL synchronously so the very first render already
 * has one — no `useState`-in-effect pattern the React lint disallows —
 * and a paired `useEffect` cleanup revokes it. `new Uint8Array(bytes)`
 * copies into a fresh ArrayBuffer-backed view, which is what `BlobPart`
 * demands (the seam itself returns `Uint8Array<ArrayBufferLike>`, which
 * is not structurally a `BlobPart`); the copy is one-shot per open and
 * the archive size is size-capped by the preview above it.
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
    title={`Preview of ${fileName}`}
    src={blobUrl}
    // Firefox's pdf.js needs scripts to render; Chrome's native viewer runs
    // regardless. `allow-same-origin` is intentionally omitted — the pair
    // (allow-scripts + allow-same-origin) is equivalent to no sandbox at
    // all (the frame's scripts can reach back through the parent). If a
    // browser's PDF viewer cannot render under this sandbox, the fallback
    // "Download raw" action outside the frame still works.
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
        This archive is {formatBytesMib(sizeBytes)} — too large to preview inline. Use "Download
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

/** Result of {@link renderJsonPreview}. */
type JsonRender =
  | { readonly _tag: 'too-large'; readonly sizeBytes: number }
  | { readonly _tag: 'rendered'; readonly text: string }

/**
 * Turn an archive's bytes into what the JSON preview body renders — the
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
  ServerArchiveList,
  type ServerArchiveListProps,
  UNDATED_LABEL,
  UNTITLED_LABEL,
}
