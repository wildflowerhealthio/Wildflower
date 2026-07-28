import { DateTime } from 'effect'
import type { JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { StatusBadge } from 'react-tundraish'

import { AttachmentViewer } from '../attachments/attachment-viewer.tsx'
import { fromFhirAttachment } from '../attachments/viewable-attachment.ts'
import type { FoundDocument } from '../queries/documents.ts'
import {
  describeCategories,
  describeConcept,
  describeIdentifiers,
  documentTitle,
  statusTone,
} from './describe-document.ts'
import styles from './document-detail.module.css'

/** Props for {@link DocumentDetail}. */
interface DocumentDetailProps {
  /** The document to show, exactly as the server returned it. */
  readonly document: FoundDocument
  readonly className?: string
}

/** One `<dt>`/`<dd>` pair, rendered only when the record actually states a value. */
const Row = ({
  name,
  value,
}: {
  readonly name: string
  readonly value: string | null
}): JSX.Element | null =>
  value === null ? null : (
    <>
      <dt className={cn(styles['detail__field-name'], 'text-body-3')}>{name}</dt>
      <dd className={cn(styles['detail__field-value'], 'text-body-3')}>{value}</dd>
    </>
  )

/**
 * One `DocumentReference` in full: its metadata, and every attachment it
 * carries.
 *
 * @remarks
 * This is the documents-tab half of the shared attachment viewer: the
 * attachments render through the **same** `AttachmentViewer` the recordings tab
 * uses, adapted by `fromFhirAttachment`. See the "one attachment viewer, two
 * adapters" trap in the package `AGENTS.md` for why neither source type could
 * be the viewer's input on its own.
 *
 * Content renders raw, and an attachment held elsewhere is named rather than
 * fetched.
 */
const DocumentDetail = ({ document, className }: DocumentDetailProps): JSX.Element => (
  <article className={cn(styles['detail'], className)}>
    <div>
      <div className={styles['detail__summary']}>
        <StatusBadge tone={statusTone(document.status)}>{document.status}</StatusBadge>
        {document.date === null ? null : (
          <span className="text-body-3">
            {new Date(DateTime.toEpochMillis(document.date)).toLocaleString()}
          </span>
        )}
      </div>
      <p className={cn(styles['detail__title'], 'text-body-2')}>{documentTitle(document)}</p>
    </div>

    <section aria-label="Document metadata">
      <h3 className={cn(styles['detail__section-title'], 'text-label-3')}>Metadata</h3>
      <dl className={styles['detail__fields']}>
        <Row name="Id" value={document.id} />
        <Row name="Type" value={describeConcept(document.type)} />
        <Row name="Category" value={describeCategories(document)} />
        <Row name="Doc status" value={document.docStatus} />
        <Row name="Description" value={document.description} />
        <Row name="Identifiers" value={describeIdentifiers(document)} />
      </dl>
    </section>

    <section aria-label="Document content">
      <h3 className={cn(styles['detail__section-title'], 'text-label-3')}>
        {document.content.length === 1 ? 'Content' : `Content (${document.content.length})`}
      </h3>
      {document.content.length === 0 ? (
        <p className={cn(styles['detail__note'], 'text-body-3')}>
          This document reference carries no content.
        </p>
      ) : (
        <div className={styles['detail__contents']}>
          {document.content.map((content, index) => (
            <AttachmentViewer
              // `content` is an ordered 1..* array with no natural key of its
              // own — two entries can carry byte-identical attachments in
              // different formats — so position is the identity here.
              // oxlint-disable-next-line react/no-array-index-key -- content entries have no id; position is the key
              key={index}
              attachment={fromFhirAttachment(content.attachment)}
              label={document.content.length === 1 ? 'Attachment' : `Attachment ${index + 1}`}
            />
          ))}
        </div>
      )}
    </section>
  </article>
)

export { DocumentDetail, type DocumentDetailProps }
