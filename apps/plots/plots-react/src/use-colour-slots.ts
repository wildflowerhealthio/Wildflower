import { useState } from 'react'

import { ColourSlots, type Series } from '@wildflowerhealthio/plots-fundamentals'

/**
 * Each selected value series' palette index: `ColourSlots.assign` over the
 * series in selection order, carried from one render to the next so a
 * survivor keeps its colour.
 *
 * @remarks
 * The page holds it above the view switch and hands it to the chart and the
 * scatter, so changing views never reassigns a colour. Derived state rather
 * than an effect: when the selection changes the new assignment is stored
 * during render, so the first paint already wears it. The assignment returned
 * is the stored one itself while the selection holds, so a figure is not
 * rebuilt for an unchanged one.
 */
const useColourSlots = (series: readonly Series.ValueSeries[]): ColourSlots.ColourSlots => {
  const ids = series.map(({ id }) => id)
  const [kept, setKept] = useState<ColourSlots.ColourSlots>(() =>
    ColourSlots.assign(new Map(), ids)
  )
  const current = ColourSlots.assign(kept, ids)
  if (current !== kept) setKept(current)
  return current
}

export { useColourSlots }
