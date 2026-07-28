import { useState, type JSX } from 'react'
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

/** `1,024 bytes`, or nothing when the size was never recorded. */
const describeSize = (size: number | null): string | null =>
  size === null ? null : `${size.toLocaleString()} bytes`

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
  const [revealedLarge, setRevealedLarge] = useState(false)

  const size = describeSize(attachment.size)
  const absenceNote = describeAbsence(attachment)
  const previewKind = previewKindFor(attachment.contentType)

  const content = ((): JSX.Element | null => {
    if (attachment.data === null) return null
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

    const text = decodeText(attachment.data)
    if (text === null) {
      return (
        <p className={cn(styles['attachment__note'], 'text-body-3')}>
          <StatusBadge tone="warning">Body is not decodable base64</StatusBadge>
        </p>
      )
    }
    if (text.length > PREVIEW_CHARACTER_CAP && !revealedLarge) {
      return (
        <button
          type="button"
          className={cn(styles['attachment__reveal'], 'button-3 outline')}
          onClick={(): void => {
            setRevealedLarge(true)
          }}
        >
          {`Show ${text.length.toLocaleString()} characters`}
        </button>
      )
    }
    return (
      <pre className={cn(styles['attachment__body'], 'text-body-3')}>
        {previewKind === 'json' ? formatJson(text) : text}
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
