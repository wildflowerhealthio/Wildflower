import type { DateTime } from 'effect'

import { type Series, isObservationSeries, seriesId } from './series.ts'
import type { TimeDomain } from './time-range.ts'

/**
 * `Observation.category` codes in panel order — roughly how often a reader
 * looks for them. A category outside this list falls into `other`, never out.
 */
const CATEGORY_ORDER: readonly string[] = [
  'vital-signs',
  'laboratory',
  'exam',
  'survey',
  'imaging',
  'procedure',
  'social-history',
  'therapy',
  'activity',
]

/** Group id for observations whose category is absent or outside {@link CATEGORY_ORDER}. */
const OTHER_GROUP = 'other'

/** Group id for the medication dose series, listed after every observation group. */
const MEDICATIONS_GROUP = 'medications'

/** Human labels for the group ids, for a panel that renders headings. */
const GROUP_LABELS: Readonly<Record<string, string>> = {
  'vital-signs': 'Vital signs',
  laboratory: 'Laboratory',
  exam: 'Exam',
  survey: 'Survey',
  imaging: 'Imaging',
  procedure: 'Procedure',
  'social-history': 'Social history',
  therapy: 'Therapy',
  activity: 'Activity',
  [OTHER_GROUP]: 'Other',
  [MEDICATIONS_GROUP]: 'Medications',
}

/** One selectable line in the catalogue panel. */
interface CatalogRow {
  /** {@link seriesId} of the series this row selects. */
  readonly id: string
  readonly label: string
  readonly unit: string | null
  /** How many points (or dose segments) the series holds. */
  readonly count: number
  /** The `[first, last]` instants the series spans, or `null` when it is empty. */
  readonly span: TimeDomain | null
}

/** One heading in the catalogue panel and the rows under it. */
interface CatalogGroup {
  readonly id: string
  readonly label: string
  readonly rows: readonly CatalogRow[]
}

/** The instants a series covers, for a row's `span`. */
const spanOf = (series: Series): TimeDomain | null => {
  const instants: DateTime.Utc[] = isObservationSeries(series)
    ? series.points.map((point) => point.time)
    : series.segments.flatMap((segment) => [
        segment.start,
        ...(segment.end === null ? [] : [segment.end]),
      ])
  const first = instants[0]
  if (first === undefined) return null
  let low = first
  let high = first
  for (const instant of instants) {
    if (instant.epochMillis < low.epochMillis) low = instant
    if (instant.epochMillis > high.epochMillis) high = instant
  }
  return [low, high]
}

/** The row a series contributes to the panel. */
const rowFor = (series: Series): CatalogRow => ({
  id: seriesId(series.key),
  label: series.label,
  unit: series.unit,
  count: isObservationSeries(series) ? series.points.length : series.segments.length,
  span: spanOf(series),
})

/** The group id a series belongs under. */
const groupIdFor = (series: Series): string => {
  if (!isObservationSeries(series)) return MEDICATIONS_GROUP
  const category = series.category
  return category !== null && CATEGORY_ORDER.includes(category) ? category : OTHER_GROUP
}

/**
 * Lay the selectable series out as the catalogue panel's groups.
 *
 * @returns Non-empty groups only, in {@link CATEGORY_ORDER} with `other` then
 *   `medications` last; rows keep input order within a group
 *
 * @remarks
 * Empty groups are omitted: the headings map what this record holds, not what
 * FHIR defines.
 */
const groupForPanel = (series: readonly Series[]): readonly CatalogGroup[] => {
  const order = [...CATEGORY_ORDER, OTHER_GROUP, MEDICATIONS_GROUP]
  const rows = new Map<string, CatalogRow[]>()
  for (const entry of series) {
    const id = groupIdFor(entry)
    const existing = rows.get(id)
    if (existing === undefined) rows.set(id, [rowFor(entry)])
    else existing.push(rowFor(entry))
  }
  return order.flatMap((id): readonly CatalogGroup[] => {
    const groupRows = rows.get(id)
    return groupRows === undefined || groupRows.length === 0
      ? []
      : [{ id, label: GROUP_LABELS[id] ?? id, rows: groupRows }]
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
export {
  CATEGORY_ORDER,
  GROUP_LABELS,
  MEDICATIONS_GROUP,
  OTHER_GROUP,
  groupForPanel,
  matchesSearch,
  normaliseForSearch,
}
