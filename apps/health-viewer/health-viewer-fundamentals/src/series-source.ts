import { deepFreeze } from '@wildflowerhealthio/kitchen-sink'

import type * as Series from './series.ts'

/** One heading of the catalogue panel: a stable `id` and the `label` it shows. */
interface SeriesGroup {
  readonly id: string
  readonly label: string
}

/**
 * What a domain source makes of a patient's record: the series it can plot,
 * and how many of its inputs it could not.
 *
 * - `undated`: inputs that carried a plottable value but no time to place it
 *   at.
 * - `dropped`: inputs that contributed nothing — no plottable value, or a
 *   status the domain never plots.
 *
 * Every input moves at most one counter, so nothing disappears silently: a UI
 * can say "12 results could not be dated" rather than silently plot fewer.
 */
interface Reading<TSeries extends Series.Series> {
  readonly series: readonly TSeries[]
  readonly undated: number
  readonly dropped: number
}

/**
 * "A health-viewer domain source" as one value: everything the viewer needs
 * to plot one kind of record without knowing that record's type.
 *
 * - `name`: stable identifier for logs and tests (`'observations'`).
 * - `idPrefix`: the prefix every id this source mints starts with, before
 *   `SeriesId`'s `:` — distinct across the sources a viewer assembles, so a
 *   URL's ids dispatch to the source that can read them.
 * - `groups`: the catalogue headings this source files series under, in
 *   panel order.
 * - `read`: the record's resources → the source's series, with its
 *   {@link Reading} accounting.
 * - `seriesIdOf` / `parseSeriesId`: the source's key grammar and its exact
 *   inverse. `parseSeriesId` never throws and reads only ids `seriesIdOf`
 *   could have written, so an id that parses is already canonical.
 * - `groupIdOf`: which of `groups` a series is filed under.
 *
 * @typeParam TResources - What `read` is handed. Each domain reads different
 *   resource types (observations; requests and statements for medications), so
 *   the viewer supplies each source its own.
 * @typeParam TKey - The domain's own identity for a series, which its ids
 *   encode.
 * @typeParam TSeries - The domain's series: a `PointSeries` or `LevelSeries`
 *   carrying whatever domain fields `groupIdOf` needs.
 *
 * @remarks
 * `read` lives here, typed by `TResources`, so a domain package's whole
 * surface is this one value — registering a source is appending it to the
 * viewer's closed list. The viewer still calls each source's `read` by name,
 * because only it knows which resources belong to which source.
 */
interface SeriesSource<TResources, TKey, TSeries extends Series.Series> {
  readonly name: string
  readonly idPrefix: string
  readonly groups: readonly SeriesGroup[]
  readonly read: (resources: TResources) => Reading<TSeries>
  readonly seriesIdOf: (key: TKey) => string
  readonly parseSeriesId: (id: string) => TKey | null
  readonly groupIdOf: (series: TSeries) => string
}

/**
 * Shallow-clone and deep-freeze a source definition, so no caller can mutate
 * a source after the viewer has assembled it. Cloning only the known fields
 * drops any extra property on the caller's object.
 */
const make = <TResources, TKey, TSeries extends Series.Series>(
  source: SeriesSource<TResources, TKey, TSeries>
): SeriesSource<TResources, TKey, TSeries> =>
  deepFreeze({
    name: source.name,
    idPrefix: source.idPrefix,
    groups: source.groups.map((group) => ({ id: group.id, label: group.label })),
    read: source.read,
    seriesIdOf: source.seriesIdOf,
    parseSeriesId: source.parseSeriesId,
    groupIdOf: source.groupIdOf,
  })

export { make }
export type { Reading, SeriesGroup, SeriesSource }
