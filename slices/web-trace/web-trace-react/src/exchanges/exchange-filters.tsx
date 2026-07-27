import { useId, type ChangeEvent, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { Field, TextField } from 'react-tundraish'

import { ANY, STATUS_CLASSES, type ExchangeFilters, type StatusClass } from './filter-exchanges.ts'
import styles from './exchange-filters.module.css'

/** Props for {@link ExchangeFiltersBar}. */
interface ExchangeFiltersBarProps {
  /** The active filters. Fully controlled — this component holds no state. */
  readonly filters: ExchangeFilters
  /** Called with the next whole filter set whenever any control changes. */
  readonly onFiltersChange: (next: ExchangeFilters) => void
  /**
   * The content types offered by the content-type select, from
   * `contentTypeOptions` over the *unfiltered* exchanges.
   *
   * @remarks
   * Passing the unfiltered options is what keeps the select from collapsing to
   * the one type already chosen, which would make the choice unrecoverable.
   */
  readonly contentTypes: readonly string[]
  readonly className?: string
}

/** Whether a string is one of the {@link StatusClass} values a select can produce. */
const isStatusClass = (value: string): value is StatusClass =>
  value === ANY || STATUS_CLASSES.some((statusClass) => statusClass === value)

/**
 * The exchange list's filter controls: a URL search box and selects for
 * response class and content type.
 *
 * @remarks
 * Fully controlled, so the filter state lives with whatever also owns the
 * filtered list and the controls can never disagree with the rows. The status
 * select offers fixed response classes; content types come from `contentTypes`,
 * since the capture stores bodies of any type.
 */
const ExchangeFiltersBar = ({
  filters,
  onFiltersChange,
  contentTypes,
  className,
}: ExchangeFiltersBarProps): JSX.Element => {
  const statusId = useId()
  const contentTypeId = useId()

  return (
    <div className={cn(styles['filters'], className)}>
      <TextField
        label="URL contains"
        type="search"
        value={filters.urlQuery}
        placeholder="/api/v2/patients"
        onChange={(urlQuery: string): void => {
          onFiltersChange({ ...filters, urlQuery })
        }}
      />

      <Field label="Status" htmlFor={statusId}>
        <select
          id={statusId}
          className={cn(styles['filters__select'], 'input-2')}
          value={filters.statusClass}
          onChange={(event: ChangeEvent<HTMLSelectElement>): void => {
            const next = event.target.value
            if (isStatusClass(next)) onFiltersChange({ ...filters, statusClass: next })
          }}
        >
          <option value={ANY}>Any status</option>
          {STATUS_CLASSES.map((statusClass) => (
            <option key={statusClass} value={statusClass}>
              {statusClass === 'other' ? 'Other / opaque' : statusClass}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Content type" htmlFor={contentTypeId}>
        <select
          id={contentTypeId}
          className={cn(styles['filters__select'], 'input-2')}
          value={filters.contentType}
          onChange={(event: ChangeEvent<HTMLSelectElement>): void => {
            onFiltersChange({ ...filters, contentType: event.target.value })
          }}
        >
          <option value={ANY}>Any content type</option>
          {contentTypes.map((contentType) => (
            <option key={contentType} value={contentType}>
              {contentType}
            </option>
          ))}
        </select>
      </Field>
    </div>
  )
}

export { ExchangeFiltersBar, type ExchangeFiltersBarProps }
