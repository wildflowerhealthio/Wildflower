import { DateTime } from 'effect'
import type { JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { ItemList, StatusBadge, type ItemListItem } from 'react-tundraish'

import type { FoundDocument } from '../queries/documents.ts'
import {
  describeCategories,
  describeContent,
  documentTitle,
  statusTone,
} from './describe-document.ts'
import { DocumentFiltersBar } from './document-filters-bar.tsx'
import { isNarrowed, type DocumentFilters } from './document-filters.ts'
import styles from './documents-list.module.css'

/** Props for {@link DocumentsList}. */
interface DocumentsListProps {
  /** The documents to list, in the order the server returned them. */
  readonly documents: readonly FoundDocument[]
  /** The active filters. Fully controlled. */
  readonly filters: DocumentFilters
  /** Called with the next whole filter set whenever a control changes. */
  readonly onFiltersChange: (next: DocumentFilters) => void
  /** Called with a document when its row is activated. */
  readonly onSelectDocument: (document: FoundDocument) => void
  /** Whether the server reported further pages. */
  readonly hasMore: boolean
  /** Whether a further page is in flight. */
  readonly isLoadingMore: boolean
  /** Fetches the next page. */
  readonly onLoadMore: () => void
  readonly className?: string
}

/**
 * The device's `DocumentReference`s, of any category, filtered server-side.
 *
 * @remarks
 * Rows show what the record says and nothing more — see `describe-document.ts`
 * for why a concept with neither `text` nor `coding` contributes nothing rather
 * than a placeholder.
 */
const DocumentsList = ({
  documents,
  filters,
  onFiltersChange,
  onSelectDocument,
  hasMore,
  isLoadingMore,
  onLoadMore,
  className,
}: DocumentsListProps): JSX.Element => {
  const items: readonly ItemListItem[] = documents.map((document) => ({
    id: document.id,
    title: <span className={styles['documents__title']}>{documentTitle(document)}</span>,
    subtitle: describeContent(document),
    badge: <StatusBadge tone={statusTone(document.status)}>{document.status}</StatusBadge>,
    meta:
      document.date === null
        ? (describeCategories(document) ?? '')
        : new Date(DateTime.toEpochMillis(document.date)).toLocaleString(),
    onClick: (): void => {
      onSelectDocument(document)
    },
  }))

  return (
    <div className={cn(styles['documents'], className)}>
      <DocumentFiltersBar filters={filters} onFiltersChange={onFiltersChange} />

      {items.length === 0 ? (
        <p className={cn(styles['documents__empty'], 'text-body-2')}>
          {isNarrowed(filters)
            ? 'No documents on this device match this search.'
            : 'No documents on this device.'}
        </p>
      ) : (
        <ItemList items={items} />
      )}

      {hasMore ? (
        <button
          type="button"
          className={cn(styles['documents__more'], 'button-3 outline')}
          disabled={isLoadingMore}
          onClick={onLoadMore}
        >
          {isLoadingMore ? 'Loading…' : 'Load more documents'}
        </button>
      ) : null}
    </div>
  )
}

export { DocumentsList, type DocumentsListProps }
