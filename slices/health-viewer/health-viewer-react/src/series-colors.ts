import { ValueAxis } from 'health-viewer-fundamentals'

/** A series' colours: its mark colour and the fill behind its `low` / `high` band. */
interface SeriesColors {
  /** `--color-series-N` — lines, dots, tick marks and legend keys. Never text. */
  readonly mark: string
  /** `--color-series-N-soft` — the wash behind a band. Never a mark. */
  readonly band: string
}

/**
 * The react-tundraish categorical tokens for palette index `position` — a
 * series' entry in `ColourSlots.assign`, not its place in the chart's `axes`.
 *
 * @throws When `position` is past `ValueAxis.CAP` — the palette holds exactly
 *   that many validated slots and is never cycled
 *
 * @remarks
 * Index N takes `--color-series-(N + 1)` in fixed order. The values stay
 * `var()` references, so dark mode swaps them with the stylesheet and nothing
 * here knows a hex.
 */
const seriesColors = (position: number): SeriesColors => {
  if (!Number.isInteger(position) || position < 0 || position >= ValueAxis.CAP) {
    throw new Error(`Series slot ${position} is outside the ${ValueAxis.CAP} categorical slots`)
  }
  const slot = position + 1
  return {
    mark: `var(--color-series-${slot})`,
    band: `var(--color-series-${slot}-soft)`,
  }
}

export type { SeriesColors }
export { seriesColors }
