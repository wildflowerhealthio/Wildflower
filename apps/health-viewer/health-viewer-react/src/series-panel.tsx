import { Checkbox, TextField } from '@wildflowerhealthio/react-tundraish'
import { DateTime } from 'effect'
import type { JSX } from 'react'
import { useCallback, useMemo, useState } from 'react'

import {
  type CatalogGroup,
  type CatalogRow,
  matchesSearch,
  normaliseForSearch,
} from '@wildflowerhealthio/health-viewer-core-js'
import {
  type Series,
  type TimeDomain,
  ValueAxis,
} from '@wildflowerhealthio/health-viewer-fundamentals'

import styles from './series-panel.module.css'

interface SeriesPanelProps {
  /** The catalogue to choose from, as `groupForPanel` lays it out. */
  readonly catalogGroups: readonly CatalogGroup[]
  /** The ids of the plotted series, in selection order — the order that decides axis sides. */
  readonly selectedSeriesIds: readonly string[]
  /**
   * Called with the whole next selection: a toggled series' id appended or
   * removed, or `[]` on Clear.
   */
  readonly onSelectionChange: (selectedSeriesIds: readonly string[]) => void
}

/** The hint shown once the selection is full, naming the cap `ValueAxis.assign` enforces. */
const CAP_REACHED_HINT = `Up to ${ValueAxis.CAP} series at once`

/** What a row counts, by the kind of series it selects: a point series' readings, a level series' levels. */
const COUNTED_NOUN: Readonly<Record<Series.Series['kind'], string>> = {
  points: 'reading',
  levels: 'period',
}

/** `amount` with its noun, pluralised with a plain `s`. */
const formatCount = (amount: number, noun: string): string =>
  `${amount} ${amount === 1 ? noun : `${noun}s`}`

/**
 * A month and year in the reader's locale and zone, e.g. `Mar 2021`. One
 * formatter for every row: `DateTime.formatLocal` builds a new
 * `Intl.DateTimeFormat` per call, and every row re-renders on each keystroke.
 */
const MONTH_YEAR_FORMAT = new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric' })

const formatMonthYear = (instant: DateTime.Utc): string =>
  DateTime.formatIntl(instant, MONTH_YEAR_FORMAT)

/** A row's span as `Mar 2021 – Jun 2024`, one month when both ends share it; `null` when empty. */
const formatSpan = (span: TimeDomain.TimeDomain | null): string | null => {
  if (span === null) return null
  const firstMonth = formatMonthYear(span[0])
  const lastMonth = formatMonthYear(span[1])
  return firstMonth === lastMonth ? firstMonth : `${firstMonth} – ${lastMonth}`
}

/**
 * `selectedSeriesIds` with `seriesId` appended (when `checked`) or removed,
 * the other ids keeping their order.
 */
const toggleSeriesInSelection = (
  selectedSeriesIds: readonly string[],
  seriesId: string,
  checked: boolean
): readonly string[] =>
  checked
    ? [...selectedSeriesIds, seriesId]
    : selectedSeriesIds.filter((selectedId) => selectedId !== seriesId)

/** A catalogue group with the rows the current search leaves visible. */
interface GroupSearchMatches {
  readonly group: CatalogGroup
  readonly matchingRows: readonly CatalogRow[]
}

/** What the panel says in place of its groups, or `null` when some rows are shown. */
const emptyMessageFor = (
  catalogGroups: readonly CatalogGroup[],
  groupsWithMatches: readonly GroupSearchMatches[],
  searchQuery: string
): string | null => {
  if (catalogGroups.length === 0) return 'No plottable series in this record.'
  if (groupsWithMatches.length === 0) return `No series match “${searchQuery.trim()}”.`
  return null
}

/** Which groups the reader has folded away, by group id; every group starts open. */
const useCollapsedGroups = (): {
  readonly isGroupCollapsed: (groupId: string) => boolean
  readonly toggleGroupCollapsed: (groupId: string) => void
} => {
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<ReadonlySet<string>>(() => new Set())
  const isGroupCollapsed = useCallback(
    (groupId: string) => collapsedGroupIds.has(groupId),
    [collapsedGroupIds]
  )
  const toggleGroupCollapsed = useCallback((groupId: string) => {
    setCollapsedGroupIds((previousGroupIds) => {
      const nextGroupIds = new Set(previousGroupIds)
      if (!nextGroupIds.delete(groupId)) nextGroupIds.add(groupId)
      return nextGroupIds
    })
  }, [])
  return { isGroupCollapsed, toggleGroupCollapsed }
}

interface SeriesRowProps {
  readonly row: CatalogRow
  readonly checked: boolean
  readonly disabled: boolean
  readonly onToggle: (checked: boolean) => void
}

/**
 * One selectable series: its label and unit, then how many readings (or, for
 * a level series, periods) it holds and the months it spans.
 */
const SeriesRow = ({ row, checked, disabled, onToggle }: SeriesRowProps): JSX.Element => {
  const span = formatSpan(row.span)
  return (
    <li className={styles.row}>
      <Checkbox
        className={styles['row-checkbox']}
        checked={checked}
        disabled={disabled}
        onChange={onToggle}
        label={
          <span className={styles['row-text']}>
            <span className={styles['row-title']}>
              <span className={styles['row-name']}>{row.label}</span>
              {row.unit !== null && <span className={styles['row-unit']}>{row.unit}</span>}
            </span>
            <span className={styles['row-meta']}>
              {formatCount(row.count, COUNTED_NOUN[row.seriesKind])}
              {span !== null && ` · ${span}`}
            </span>
          </span>
        }
      />
    </li>
  )
}

/**
 * The series picker beside the chart: a search box over every discovered
 * series, the catalogue's groups as collapsible headings with their row
 * counts, and a checkbox per series.
 *
 * @remarks
 * The selection is the caller's; this component only proposes the next one
 * through {@link SeriesPanelProps.onSelectionChange}. A toggled row's id is
 * appended to or removed from `selectedSeriesIds`, preserving the order the
 * axes are assigned in. Once `ValueAxis.CAP` series are selected every
 * unchecked row is disabled and a hint says why — the checked rows stay
 * enabled so one can be swapped out. Search filters through the core's
 * `matchesSearch`, hides groups left empty, and counts each group's matches
 * against its size while a query is typed; fold state is local, and every
 * group starts open. Ids are opaque here: the panel compares them and never
 * reads them.
 */
const SeriesPanel = ({
  catalogGroups,
  selectedSeriesIds,
  onSelectionChange,
}: SeriesPanelProps): JSX.Element => {
  const [searchQuery, setSearchQuery] = useState('')
  const { isGroupCollapsed, toggleGroupCollapsed } = useCollapsedGroups()

  const selectedSeriesIdSet = useMemo(() => new Set(selectedSeriesIds), [selectedSeriesIds])
  const groupsWithMatches = useMemo(
    (): readonly GroupSearchMatches[] =>
      catalogGroups.flatMap((group) => {
        const matchingRows = group.rows.filter((row) => matchesSearch(row, searchQuery))
        return matchingRows.length === 0 ? [] : [{ group, matchingRows }]
      }),
    [catalogGroups, searchQuery]
  )
  const emptyMessage = emptyMessageFor(catalogGroups, groupsWithMatches, searchQuery)
  const selectionIsFull = selectedSeriesIds.length >= ValueAxis.CAP
  const searchIsActive = normaliseForSearch(searchQuery) !== ''

  return (
    <div className={styles.panel}>
      <TextField
        label="Search series"
        type="search"
        value={searchQuery}
        onChange={setSearchQuery}
      />
      <div className={styles.summary}>
        <span>
          {selectedSeriesIds.length} of {ValueAxis.CAP} selected
        </span>
        <button
          type="button"
          className={styles.clear}
          disabled={selectedSeriesIds.length === 0}
          onClick={() => {
            onSelectionChange([])
          }}
        >
          Clear
        </button>
      </div>
      <p className={styles.hint} role="status">
        {selectionIsFull ? CAP_REACHED_HINT : null}
      </p>
      {emptyMessage !== null ? (
        <p className={styles.empty}>{emptyMessage}</p>
      ) : (
        <ul className={styles.groups}>
          {groupsWithMatches.map(({ group, matchingRows }) => {
            const groupIsOpen = !isGroupCollapsed(group.id)
            return (
              <li key={group.id} className={styles.group}>
                <button
                  type="button"
                  className={styles['group-toggle']}
                  aria-expanded={groupIsOpen}
                  onClick={() => {
                    toggleGroupCollapsed(group.id)
                  }}
                >
                  <span
                    className={groupIsOpen ? styles['triangle-open'] : styles['triangle-closed']}
                    aria-hidden="true"
                  />
                  <span className={styles['group-name']}>{group.label}</span>
                  <span className={styles['group-count']}>
                    {searchIsActive
                      ? `${matchingRows.length} of ${group.rows.length}`
                      : group.rows.length}
                  </span>
                </button>
                {groupIsOpen && (
                  <ul className={styles.rows}>
                    {matchingRows.map((row) => {
                      const rowIsSelected = selectedSeriesIdSet.has(row.id)
                      return (
                        <SeriesRow
                          key={row.id}
                          row={row}
                          checked={rowIsSelected}
                          disabled={selectionIsFull && !rowIsSelected}
                          onToggle={(checked) => {
                            onSelectionChange(
                              toggleSeriesInSelection(selectedSeriesIds, row.id, checked)
                            )
                          }}
                        />
                      )
                    })}
                  </ul>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

export { SeriesPanel }
export type { SeriesPanelProps }
