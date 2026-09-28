import type { Series, SeriesSource } from 'health-viewer-fundamentals'
import {
  type ObservationResource,
  type ObservationSeries,
  type ObservationSeriesKey,
  observationSource,
} from 'health-viewer-observations'

/**
 * The domain sources the viewer plots, in the order their catalogue groups
 * are listed — a closed list: plotting a new kind of record is adding its
 * source here and to {@link RecordResources} / {@link readRecord}.
 *
 * @remarks
 * Only observations so far. A medication id (`m:`) therefore reads as unknown
 * until the medication source joins this list.
 */
const SERIES_SOURCES: readonly [
  SeriesSource.SeriesSource<
    readonly ObservationResource[],
    ObservationSeriesKey,
    ObservationSeries
  >,
] = [observationSource]

/** The resources of a patient's record each source is handed, by source. */
interface RecordResources {
  readonly observations: readonly ObservationResource[]
}

/** A series and the catalogue group its source files it under. */
interface FiledSeries {
  readonly groupId: string
  readonly series: Series.Series
}

/**
 * Everything the record can plot, and — summed across sources — how many
 * inputs could not be: the {@link SeriesSource.Reading} accounting, so the UI
 * can say what it left out.
 */
interface RecordReading {
  /** Every source's series, source by source in {@link SERIES_SOURCES} order. */
  readonly filed: readonly FiledSeries[]
  readonly undated: number
  readonly dropped: number
}

/** Read one source's resources and file each series under the group the source names. */
const readSource = <TResources, TKey, TSeries extends Series.Series>(
  source: SeriesSource.SeriesSource<TResources, TKey, TSeries>,
  resources: TResources
): RecordReading => {
  const reading = source.read(resources)
  return {
    filed: reading.series.map((series) => ({ groupId: source.groupIdOf(series), series })),
    undated: reading.undated,
    dropped: reading.dropped,
  }
}

/** Read a patient's record through every source in {@link SERIES_SOURCES}. */
const readRecord = (resources: RecordResources): RecordReading => {
  const readings = [readSource(observationSource, resources.observations)]
  return {
    filed: readings.flatMap((reading) => reading.filed),
    undated: readings.reduce((total, reading) => total + reading.undated, 0),
    dropped: readings.reduce((total, reading) => total + reading.dropped, 0),
  }
}

/**
 * Every catalogue group, in panel order: each source's own groups, source by
 * source.
 */
const CATALOG_GROUPS: readonly SeriesSource.SeriesGroup[] = SERIES_SOURCES.flatMap(
  (source) => source.groups
)

/**
 * Whether some source can read `id` — the test a series id from a URL must
 * pass to be kept.
 *
 * @remarks
 * Each source's parser only accepts ids its own `seriesIdOf` could have
 * written, so an id that passes is already in the one spelling the source's
 * series carry.
 */
const isKnownSeriesId = (id: string): boolean =>
  SERIES_SOURCES.some((source) => source.parseSeriesId(id) !== null)

export { CATALOG_GROUPS, SERIES_SOURCES, isKnownSeriesId, readRecord }
export type { FiledSeries, RecordReading, RecordResources }
