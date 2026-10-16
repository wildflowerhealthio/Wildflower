import * as ValueAxis from './value-axis.ts'

/**
 * Which categorical colour each plotted series wears, as a `0`-based index
 * into a fixed palette order, keyed by series id.
 */
type ColourSlots = ReadonlyMap<string, number>

/**
 * Give each selected series its colour, keeping the colour of every series
 * that was already drawn.
 *
 * @param previous - The assignment the chart last drew; empty on a first draw
 * @param selectedIds - The series ids now selected, in selection order, distinct
 * @returns `previous` itself when `selectedIds` names exactly its series, so
 *   an unchanged selection is an unchanged value; otherwise a new assignment in
 *   which every series still selected keeps its colour and each newcomer, in
 *   selection order, takes the lowest colour left free
 * @throws When `selectedIds` holds more than `ValueAxis.CAP` series — the
 *   palette is never cycled
 *
 * @remarks
 * Colour follows the series, not its place in the selection: removing the
 * first of three series must not repaint the other two. A first draw (or a
 * shared link opened fresh) therefore gets colours in selection order, and
 * only a selection changed in place departs from it.
 */
const assign = (previous: ColourSlots, selectedIds: readonly string[]): ColourSlots => {
  if (selectedIds.length > ValueAxis.CAP) {
    throw new Error(
      `The palette colours at most ${ValueAxis.CAP} series at once; got ${selectedIds.length}`
    )
  }
  if (selectedIds.length === previous.size && selectedIds.every((id) => previous.has(id))) {
    return previous
  }
  const next = new Map<string, number>()
  for (const id of selectedIds) {
    const kept = previous.get(id)
    if (kept !== undefined) next.set(id, kept)
  }
  const taken = new Set(next.values())
  for (const id of selectedIds) {
    if (next.has(id)) continue
    let free = 0
    while (taken.has(free)) free += 1
    next.set(id, free)
    taken.add(free)
  }
  return next
}

export { assign }
export type { ColourSlots }
