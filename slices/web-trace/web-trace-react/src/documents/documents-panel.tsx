import { useState, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { ErrorBanner, PageLoading } from 'react-tundraish'

import type { DocumentsQueryOptions, FoundDocument } from '../queries/documents.ts'
import { documentTitle } from './describe-document.ts'
import { DocumentDetail } from './document-detail.tsx'
import { NO_DOCUMENT_FILTERS, type DocumentFilters } from './document-filters.ts'
import { DocumentsList } from './documents-list.tsx'
import { useDocuments } from './use-documents.ts'
import styles from './documents-panel.module.css'

/** Props for {@link DocumentsPanel}. */
interface DocumentsPanelProps {
  /**
   * Called when a row is activated, in addition to opening the detail. Use it
   * to mirror the selection into a host app's route.
   */
  readonly onSelectDocument?: (document: FoundDocument) => void
  /** Page size for the underlying read. The filters are this panel's own state. */
  readonly queryOptions?: Omit<DocumentsQueryOptions, 'filters'>
  readonly className?: string
}

/**
 * The documents tab: every `DocumentReference` on the device, of any category,
 * and the full detail of whichever one is open. Data comes from
 * {@link useDocuments}, which reads through router context — mount it inside
 * the host app's router and `QueryClientProvider`.
 *
 * @remarks
 * Two master/detail levels — one fewer than the recordings tab, because a
 * document is a resource in its own right with no session to be grouped into.
 *
 * Filter state lives here and is part of the **query key**, so an edit
 * re-searches server-side rather than narrowing a loaded list. An open document
 * that the new results no longer contain falls back to the list rather than
 * rendering an empty detail.
 */
const DocumentsPanel = ({
  onSelectDocument,
  queryOptions,
  className,
}: DocumentsPanelProps): JSX.Element => {
  const [filters, setFilters] = useState<DocumentFilters>(NO_DOCUMENT_FILTERS)
  const [openDocumentId, setOpenDocumentId] = useState<string | null>(null)

  const { documents, isPending, hasMore, isLoadingMore, loadMore, error } = useDocuments({
    ...queryOptions,
    filters,
  })

  const openDocument = documents.find((document) => document.id === openDocumentId)

  const body = ((): JSX.Element | null => {
    if (isPending) return <PageLoading message="Loading documents…" />
    // A failed read that produced nothing says nothing: "no documents on this
    // device" is a claim about the device, and what actually happened is that
    // the device was not successfully asked.
    if (error !== null && documents.length === 0) return null
    if (openDocument !== undefined) {
      return (
        <>
          <div className={styles['documents-panel__header']}>
            <button
              type="button"
              className="button-3 outline"
              onClick={(): void => {
                setOpenDocumentId(null)
              }}
            >
              All documents
            </button>
            <p className={cn(styles['documents-panel__title'], 'text-label-3')}>
              {documentTitle(openDocument)}
            </p>
          </div>
          <DocumentDetail document={openDocument} />
        </>
      )
    }
    return (
      <DocumentsList
        documents={documents}
        filters={filters}
        onFiltersChange={(next: DocumentFilters): void => {
          setFilters(next)
          setOpenDocumentId(null)
        }}
        onSelectDocument={(document: FoundDocument): void => {
          setOpenDocumentId(document.id)
          onSelectDocument?.(document)
        }}
        hasMore={hasMore}
        isLoadingMore={isLoadingMore}
        onLoadMore={loadMore}
      />
    )
  })()

  return (
    <div className={cn(styles['documents-panel'], className)}>
      <ErrorBanner error={error} />
      {body}
    </div>
  )
}

export { DocumentsPanel, type DocumentsPanelProps }
