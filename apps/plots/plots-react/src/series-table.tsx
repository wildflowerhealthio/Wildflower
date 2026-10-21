import { Match } from 'effect'
import type { JSX } from 'react'
import { useMemo } from 'react'

import { ReadingTable, Series, type TimeDomain } from '@wildflowerhealthio/plots-fundamentals'

import { formatDateTime, formatReading, labelWithUnit } from './value-format.ts'
import styles from './series-table.module.css'

interface SeriesTableProps {
  /** The selected series, one column each, in selection order. */
  readonly series: readonly Series.Series[]
  /** The time window the rows are drawn from: the range preset's. */
  readonly timeWindow: TimeDomain.TimeDomain
}

/** A column's heading: a value series' label with its unit, a lane's label. */
const headingOf = (series: Series.Series): string =>
  Series.isValueSeries(series) ? labelWithUnit(series) : series.label

/**
 * What one entry reads in its cell: a value with the domain's `note`, the
 * column's heading carrying the unit; a span's category, starting or ending.
 */
const entryText = (entry: ReadingTable.Entry): string =>
  Match.value(entry).pipe(
    Match.when({ kind: 'value' }, ({ level }) =>
      level.note === undefined
        ? formatReading(level.value)
        : `${formatReading(level.value)} ${level.note}`
    ),
    Match.when({ kind: 'span-start' }, ({ span }) => `${span.category.label} starts`),
    Match.when({ kind: 'span-end' }, ({ span }) => `${span.category.label} ends`),
    Match.exhaustive
  )

/**
 * The selection as a table (`ReadingTable.of`): a row per instant any
 * selected series has a reading at, newest first, at its viewer-local date and
 * time; a column per series, blank where it has nothing then. A lane's column
 * says which span starts or ends there.
 *
 * @remarks
 * A cell lists each of its entries on its own line: readings sharing an
 * instant, or a span handing off to the next.
 */
const SeriesTable = ({ series, timeWindow }: SeriesTableProps): JSX.Element => {
  const table = useMemo(() => ReadingTable.of(series, timeWindow), [series, timeWindow])
  if (series.length === 0) {
    return <p className={styles['series-table__empty']}>Pick up to four series</p>
  }
  if (table.rows.length === 0) {
    return <p className={styles['series-table__empty']}>Nothing recorded in this range</p>
  }
  return (
    <div className={styles['series-table']}>
      <table className={styles['series-table__table']} aria-label="Readings">
        <thead>
          <tr>
            <th scope="col" className={styles['series-table__heading']}>
              Time
            </th>
            {table.columns.map((column) => (
              <th key={column.id} scope="col" className={styles['series-table__heading']}>
                {headingOf(column)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row) => (
            <tr key={row.time.epochMillis}>
              <th scope="row" className={styles['series-table__time']}>
                {formatDateTime(row.time)}
              </th>
              {row.cells.map((cell, column) => (
                <td key={table.columns[column].id} className={styles['series-table__cell']}>
                  {cell.map((entry, index) => (
                    // oxlint-disable-next-line react/no-array-index-key -- a cell's entries are fixed for its row, and two readings may be equal, so their place is their identity
                    <span key={index} className={styles['series-table__entry']}>
                      {entryText(entry)}
                    </span>
                  ))}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export { SeriesTable }
export type { SeriesTableProps }
