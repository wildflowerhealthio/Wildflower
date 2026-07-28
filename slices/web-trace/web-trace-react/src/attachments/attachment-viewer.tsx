import { formatBytes } from 'kitchen-sink'
import { useMemo, useState, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { Chip, StatusBadge } from 'react-tundraish'

import {
  decodeText,
  formatJson,
  imageDataUri,
  previewKindFor,
  type ViewableAttachment,
} from './viewable-attachment.ts'
import styles from './attachment-viewer.module.css'

/**
 * How much decoded text renders without being asked for explicitly.
 *
 * @remarks
 * The verbatim capture policy stores bodies whole, whatever their size, so a
 * recorded download can be tens of megabytes. Pretty-printing that into the DOM
 * on open would hang the tab. Past this, the viewer shows the metadata and a
 * control — the content is still reachable, just not by accident.
 */
const PREVIEW_CHARACTER_CAP = 200_000

/** Props for {@link AttachmentViewer}. */
interface AttachmentViewerProps {
  /** The attachment to render, from `fromTraceBody` or `fromFhirAttachment`. */
  readonly attachment: ViewableAttachment
  /** Heading for the content region. Defaults to `Body`. */
  readonly label?: string
  readonly className?: string
}

/** `1.5 KB`, or nothing when the size was never recorded. */
const describeSize = (size: number | null): string | null =>
  size === null ? null : formatBytes(size)

/** The absence note, phrased so each case says what actually happened. */
const describeAbsence = (attachment: ViewableAttachment): string | null => {
  const absence = attachment.absence
  if (absence === null) return null
  if (absence._tag === 'SkippedAtCapture') {
    return `Body not stored at capture: ${absence.reason}.`
  }
  if (absence._tag === 'ByReference') {
    return `Content is held at ${absence.url}, not in this record. The viewer does not fetch it.`
  }
  return 'This record carries no content.'
}

/**
 * The generic attachment viewer, shared by the recordings tab and the documents
 * browser. Renders the recorded metadata, then the bytes when they can be shown.
 *
 * @remarks
 * Content is shown exactly as recorded — this is the user's own device and their
 * own data, and nothing here redacts.
 *
 * The bytes render according to `previewKindFor`: JSON re-indented, textual
 * types decoded, raster images from a `data:` URI. An unrecognised type shows
 * its metadata and no preview rather than arbitrary bytes rendered as text. A
 * body whose base64 does not decode says so instead of rendering blank.
 */
const AttachmentViewer = ({
  attachment,
  label = 'Body',
  className,
}: AttachmentViewerProps): JSX.Element => {
  /**
   * The bytes the reveal was granted for, not a bare flag: this viewer is
   * shared, and a leftover `true` would open the *next* large body handed to the
   * same instance — see the package `AGENTS.md`.
   */
  const [revealedBody, setRevealedBody] = useState<string | null>(null)

  const { data } = attachment
  const size = describeSize(attachment.size)
  const absenceNote = describeAbsence(attachment)
  const previewKind = previewKindFor(attachment.contentType)

  /**
   * Memoized because the cap can only be checked against the decoded length, so
   * this runs *before* the guard on a string that may be tens of megabytes.
   */
  const decoded = useMemo(
    (): string | null =>
      data === null || previewKind === 'none' || previewKind === 'image' ? null : decodeText(data),
    [data, previewKind]
  )

  const withheld =
    decoded !== null && decoded.length > PREVIEW_CHARACTER_CAP && revealedBody !== data

  const content = ((): JSX.Element | null => {
    if (data === null) return null
    if (previewKind === 'none') {
      return (
        <p className={cn(styles['attachment__note'], 'text-body-3')}>
          Stored, but this content type has no inline preview.
        </p>
      )
    }
    if (previewKind === 'image') {
      return (
        <img
          className={styles['attachment__image']}
          src={imageDataUri(attachment)}
          alt={`Recorded image body${attachment.title === null ? '' : ` for ${attachment.title}`}`}
        />
      )
    }
    if (decoded === null) {
      return (
        <p className={cn(styles['attachment__note'], 'text-body-3')}>
          <StatusBadge tone="warning">Body is not decodable base64</StatusBadge>
        </p>
      )
    }
    if (withheld) {
      return (
        <button
          type="button"
          className={cn(styles['attachment__reveal'], 'button-3 outline')}
          onClick={(): void => {
            setRevealedBody(data)
          }}
        >
          {`Show ${decoded.length.toLocaleString()} characters`}
        </button>
      )
    }
    return (
      <pre className={cn(styles['attachment__body'], 'text-body-3')}>
        {previewKind === 'json' ? formatJson(decoded) : decoded}
      </pre>
    )
  })()

  return (
    <section className={cn(styles['attachment'], className)} aria-label={label}>
      <p className={styles['attachment__meta']}>
        <Chip>{attachment.contentType === '' ? 'unknown type' : attachment.contentType}</Chip>
        {size === null ? null : <span className="text-body-3">{size}</span>}
        {attachment.hash === null ? null : (
          <span className={cn(styles['attachment__hash'], 'text-body-3')}>
            {`sha256 ${attachment.hash}`}
          </span>
        )}
      </p>

      {absenceNote === null ? null : (
        <p className={cn(styles['attachment__note'], 'text-body-3')}>
          <StatusBadge tone="warning">{absenceNote}</StatusBadge>
        </p>
      )}

      {content}
    </section>
  )
}

export { AttachmentViewer, type AttachmentViewerProps, PREVIEW_CHARACTER_CAP }
