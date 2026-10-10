/**
 * The health viewer's plot vocabulary, free of any medical domain, exposed as
 * one namespace per module in the `effect` style: the file is the noun, the
 * principal type shares its name (`PointSeries.PointSeries`), and functions
 * read in the namespace's context (`ValueAxis.assign`, `Crosshair.stops`,
 * `PointSeries.toLevels`).
 *
 * Domain packages read their records into these types; the viewer's core and
 * its React layer draw them without knowing what a reading or a dose is.
 *
 * @packageDocumentation
 */
export * as Buckets from './buckets.ts'
export * as ColourSlots from './colour-slots.ts'
export * as Crosshair from './crosshair.ts'
export * as Level from './level.ts'
export * as LevelSeries from './level-series.ts'
export * as PointSeries from './point-series.ts'
export * as Series from './series.ts'
export * as SeriesId from './series-id.ts'
export * as SeriesSource from './series-source.ts'
export * as TimeDomain from './time-domain.ts'
export * as ValueAxis from './value-axis.ts'
