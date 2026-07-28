import { useId, type ChangeEvent, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { Field, TextField } from 'react-tundraish'

import { ANY } from '../exchanges/filter-exchanges.ts'
import { DOCUMENT_STATUSES, type DocumentFilters, type DocumentStatus } from './document-filters.ts'
import styles from './document-filters.module.css'

/** Props for {@link DocumentFiltersBar}. */
interface DocumentFiltersBarProps {
  /** The active filters. Fully controlled — this component holds no state. */
  readonly filters: DocumentFilters
  /** Called with the next whole filter set whenever any control changes. */
  readonly onFiltersChange: (next: DocumentFilters) => void
  readonly className?: string
}

/** Whether a string is one of the status values the select can produce. */
const isDocumentStatus = (value: string): value is DocumentStatus | typeof ANY =>
  value === ANY || DOCUMENT_STATUSES.some((status) => status === value)

/**
 * The documents browser's filter controls: category and type token boxes, and a
 * status select.
 *
 * @remarks
 * Fully controlled, like the exchange filters, so the controls can never
 * disagree with the rows. These narrow the **search** rather than a loaded
 * list, so an edit re-queries — which is why the boxes take a whole token
 * (`system|code` or a bare code) rather than a substring the server has no way
 * to match.
 */
const DocumentFiltersBar = ({
  filters,
  onFiltersChange,
  className,
}: DocumentFiltersBarProps): JSX.Element => {
  const statusId = useId()

  return (
    <div className={cn(styles['filters'], className)}>
      <TextField
        label="Category"
        type="search"
        value={filters.category}
        placeholder="http://wildflower.health/CodeSystem/web-trace|web-trace"
        description="A code, or system|code. Leave empty for every category."
        onChange={(category: string): void => {
          onFiltersChange({ ...filters, category })
        }}
      />

      <TextField
        label="Type"
        type="search"
        value={filters.type}
        placeholder="http://loinc.org|34133-9"
        description="A code, or system|code. Leave empty for every type."
        onChange={(type: string): void => {
          onFiltersChange({ ...filters, type })
        }}
      />

      <Field label="Status" htmlFor={statusId}>
        <select
          id={statusId}
          className={cn(styles['filters__select'], 'input-2')}
          value={filters.status}
          onChange={(event: ChangeEvent<HTMLSelectElement>): void => {
            const next = event.target.value
            if (isDocumentStatus(next)) onFiltersChange({ ...filters, status: next })
          }}
        >
          <option value={ANY}>Any status</option>
          {DOCUMENT_STATUSES.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
      </Field>
    </div>
  )
}

export { DocumentFiltersBar, type DocumentFiltersBarProps }
