import { type ColourSlots, SpanSeries, ValueAxis } from '@wildflowerhealthio/plots-fundamentals'

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

/**
 * The palette index `colours` gives series `seriesId`.
 *
 * @throws When `colours` holds none for it: the chart colours every series
 *   it draws with `ColourSlots.assign` first, so a miss is a bug, not a
 *   series to paint in some default
 */
const colourSlotOf = (colours: ColourSlots.ColourSlots, seriesId: string): number => {
  const slot = colours.get(seriesId)
  if (slot === undefined) throw new Error(`Series ${seriesId} has no colour slot`)
  return slot
}

/**
 * The chart's one neutral colour, a muted text step: what a span in the
 * neutral category wears instead of a lane colour, and what a shared value
 * axis' line and tick marks wear, since no one series' colour names it.
 */
const NEUTRAL_COLOUR = 'var(--color-neutral-5)'

/**
 * The react-tundraish lane token for a span category's `colourSlot`: slot N
 * takes `--color-span-(N + 1)`, and `null` {@link NEUTRAL_COLOUR}.
 *
 * @throws When `colourSlot` is outside `SpanSeries.COLOUR_SLOTS` — there are
 *   exactly that many validated lane colours, never cycled
 *
 * @remarks
 * Separate from the `--color-series-N` slots: a lane's colour names its
 * category, not the series, and fills a bar rather than stroking a line.
 */
const spanColour = (colourSlot: number | null): string => {
  if (colourSlot === null) return NEUTRAL_COLOUR
  if (!Number.isInteger(colourSlot) || colourSlot < 0 || colourSlot >= SpanSeries.COLOUR_SLOTS) {
    throw new Error(
      `Span colour slot ${colourSlot} is outside the ${SpanSeries.COLOUR_SLOTS} lane colours`
    )
  }
  return `var(--color-span-${colourSlot + 1})`
}

export type { SeriesColors }
export { NEUTRAL_COLOUR, colourSlotOf, seriesColors, spanColour }
