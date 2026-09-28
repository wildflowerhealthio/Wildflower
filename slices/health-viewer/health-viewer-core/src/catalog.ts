import { Series, type TimeDomain } from 'health-viewer-fundamentals'

import { CATALOG_GROUPS, type FiledSeries } from './series-sources.ts'

/** One selectable line in the catalogue panel. */
interface CatalogRow {
  /** The id of the series this row selects. */
  readonly id: string
  readonly label: string
  readonly unit: string | null
  /** How many readings (or levels) the series holds. */
  readonly count: number
  /** The `[first, last]` instants the series spans, or `null` when it is empty. */
  readonly span: TimeDomain.TimeDomain | null
}

/** One heading in the catalogue panel and the rows under it. */
interface CatalogGroup {
  readonly id: string
  readonly label: string
  readonly rows: readonly CatalogRow[]
}

/** The row a series contributes to the panel. */
const rowFor = (series: Series.Series): CatalogRow => ({
  id: series.id,
  label: series.label,
  unit: series.unit,
  count: Series.sizeOf(series),
  span: Series.extentOf(series),
})

/**
 * Lay the record's series out as the catalogue panel's groups.
 *
 * @param filed - Each series with the group its source filed it under
 * @returns Non-empty groups only, in `CATALOG_GROUPS` order — each source's
 *   groups, source by source; rows keep input order within a group
 * @throws When a series is filed under a group no source declares — a source
 *   breaking its own contract, which must not cost the series its row silently
 *
 * @remarks
 * Empty groups are omitted: the headings map what this record holds, not
 * everything a source could file.
 */
const groupForPanel = (filed: readonly FiledSeries[]): readonly CatalogGroup[] => {
  const rows = new Map<string, CatalogRow[]>(CATALOG_GROUPS.map((group) => [group.id, []]))
  for (const { groupId, series } of filed) {
    const groupRows = rows.get(groupId)
    if (groupRows === undefined) {
      throw new Error(`Series ${series.id} is filed under undeclared catalogue group ${groupId}`)
    }
    groupRows.push(rowFor(series))
  }
  return CATALOG_GROUPS.flatMap((group): readonly CatalogGroup[] => {
    const groupRows = rows.get(group.id) ?? []
    return groupRows.length === 0 ? [] : [{ id: group.id, label: group.label, rows: groupRows }]
  })
}

/**
 * Reduce text to lower-case, diacritic-free, single-spaced tokens for search.
 *
 * @remarks
 * Deliberately not `medication-core`'s `normalizeName`, which eats number and
 * dosage-unit tokens as noise. Here `mmol` and `24h` are the signal.
 */
const normaliseForSearch = (value: string): string =>
  value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0)
    .join(' ')

/**
 * Whether a catalogue row matches a search box's contents. Every query token
 * must appear in the row's label or unit, so order does not matter and a
 * partial word still matches.
 *
 * @returns `true` for an empty query — an unfiltered box shows everything
 */
const matchesSearch = (row: CatalogRow, query: string): boolean => {
  const tokens = normaliseForSearch(query)
    .split(' ')
    .filter((token) => token.length > 0)
  if (tokens.length === 0) return true
  const haystack = normaliseForSearch(`${row.label} ${row.unit ?? ''}`)
  return tokens.every((token) => haystack.includes(token))
}

export type { CatalogGroup, CatalogRow }
export { groupForPanel, matchesSearch, normaliseForSearch }
