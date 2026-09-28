import type { DateTime } from 'effect'

import * as Level from './level.ts'
import type { ValueScale } from './series.ts'

/**
 * How a level's line is stroked. The domain decides what a dash means — for a
 * dose, an extent that is inferred rather than stated.
 */
type LineStyle = 'solid' | 'dashed'

/** A level with the stroke its line is drawn in. */
interface StyledLevel extends Level.Level {
  readonly lineStyle: LineStyle
}

/**
 * A step line of values each held over an interval.
 *
 * - `id`, `label`, `unit`, `valueScale`: as on a `PointSeries`.
 * - `levels`: sorted ascending by `start`. Unlike a point series' levels
 *   these may overlap or leave gaps; a gap is an interval where nothing was in
 *   effect.
 */
interface LevelSeries {
  readonly kind: 'levels'
  readonly id: string
  readonly label: string
  readonly unit: string | null
  readonly valueScale: ValueScale
  readonly levels: readonly StyledLevel[]
}

/**
 * The level a crosshair reads off `series` at `time`.
 *
 * @returns The latest-starting level in effect, or `null` in a gap — with no
 *   fallback, unlike `PointSeries.levelAt`, because nothing in effect is a real
 *   answer here
 */
const levelAt = (series: LevelSeries, time: DateTime.Utc): StyledLevel | null =>
  Level.inEffectAt(series.levels, time)

export { levelAt }
export type { LevelSeries, LineStyle, StyledLevel }
