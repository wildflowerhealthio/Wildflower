import { Array as Arr, DateTime, Order, Record as EffectRecord, pipe } from 'effect'

import type * as Level from './level.ts'
import * as Series from './series.ts'
import type * as SpanSeries from './span-series.ts'
import * as TimeDomain from './time-domain.ts'

/**
 * One series' entry at a row's instant: a value series' level starting there
 * — a point series' reading, a level series' level — or a span starting or
 * ending there.
 */
type Entry =
  | { readonly kind: 'value'; readonly level: Level.Level }
  | { readonly kind: 'span-start'; readonly span: SpanSeries.Span }
  | { readonly kind: 'span-end'; readonly span: SpanSeries.Span }

/**
 * One series' entries at a row's instant, in series order. Empty where the
 * series has none there; several where readings share an instant, or where
 * one span ends as another starts.
 */
type Cell = readonly Entry[]

/** An instant at which at least one column has an entry, with each column's cell. */
interface Row {
  readonly time: DateTime.Utc
  /** One cell per column, parallel to the table's `columns`. */
  readonly cells: readonly Cell[]
}

/**
 * The selected series as a table: a column per series, and a row per instant
 * any of them has an entry at, newest first.
 */
interface ReadingTable {
  /** The series, one per column, in the order they were given. */
  readonly columns: readonly Series.Series[]
  readonly rows: readonly Row[]
}

/** An entry with the instant its row is at. */
interface TimedEntry {
  readonly time: DateTime.Utc
  readonly entry: Entry
}

/**
 * Every entry `series` has inside `window`, in series order: a value series'
 * level starts (`Series.levelsWithin`); a span series' starts and ends, each
 * span's start before its end.
 *
 * @remarks
 * Walking spans in `start` order puts a hand-off's ending span before the one
 * starting at the same instant.
 */
const timedEntriesWithin = (
  series: Series.Series,
  window: TimeDomain.TimeDomain
): readonly TimedEntry[] =>
  Series.isSpanSeries(series)
    ? TimeDomain.pointsWithin(
        series.spans.flatMap((span): readonly TimedEntry[] => [
          { time: span.start, entry: { kind: 'span-start', span } },
          { time: span.end, entry: { kind: 'span-end', span } },
        ]),
        window
      )
    : Series.levelsWithin(series, window).map((level) => ({
        time: level.start,
        entry: { kind: 'value', level },
      }))

/**
 * Lay `columns` out as a table over `window`.
 *
 * @param columns - The series to tabulate, in selection order
 * @param window - The time window the rows are drawn from, both ends included
 * @returns A row per instant inside `window` where some column has an entry,
 *   newest first, each with exactly one cell per column
 *
 * @remarks
 * A level series contributes its levels' starts only: a level's stated end is
 * where the next one starts, or the line stops, and reads on the chart rather
 * than as a value.
 */
const of = (columns: readonly Series.Series[], window: TimeDomain.TimeDomain): ReadingTable => {
  const columnEntries = columns.flatMap((series, column) =>
    timedEntriesWithin(series, window).map((timed) => ({ ...timed, column }))
  )
  const rows = pipe(
    Arr.groupBy(columnEntries, ({ time }) => String(time.epochMillis)),
    EffectRecord.values,
    Arr.map((entries): Row => ({
      time: entries[0].time,
      cells: columns.map((_, column) =>
        entries.filter((entry) => entry.column === column).map(({ entry }) => entry)
      ),
    })),
    Arr.sortWith(({ time }) => time, Order.reverse(DateTime.Order))
  )
  return { columns, rows }
}

export { of }
export type { Cell, Entry, ReadingTable, Row }
