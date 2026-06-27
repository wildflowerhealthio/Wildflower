import { arrayMove } from '@dnd-kit/sortable'

import type { AppEntry } from '../../../queries.ts'

/** The single placement write a drag produces: the moved app's id and its new
 * 0-based position in the list. */
export interface PlacementMove {
  readonly id: string
  readonly position: number
}

/**
 * Resolve a drag-end into the new tile order plus the single placement write to
 * persist it.
 *
 * `activeId`/`overId` are the dnd-kit ids of the dragged tile and the tile it
 * was dropped onto (both `AppEntry.id`s). Returns:
 *
 * - `order`: `apps` with the dragged tile moved to the drop slot — the
 *   optimistic order the homescreen renders until the list query refetches.
 * - `move`: the moved tile's id and its new 0-based index, sent as the
 *   `position` on `PATCH /apps/:id/placement`. `null` when nothing moved (a
 *   drop back onto the origin, or an unknown id), so the caller skips the
 *   write.
 *
 * Pure — no dnd-kit state, no mutation — so the reorder math is unit-testable
 * without rendering a `DndContext`.
 */
export const placementForMove = (
  apps: readonly AppEntry[],
  activeId: string,
  overId: string
): { readonly order: readonly AppEntry[]; readonly move: PlacementMove | null } => {
  if (activeId === overId) return { order: apps, move: null }
  const from = apps.findIndex((app) => app.id === activeId)
  const to = apps.findIndex((app) => app.id === overId)
  if (from === -1 || to === -1) return { order: apps, move: null }
  const order = arrayMove([...apps], from, to)
  return { order, move: { id: activeId, position: to } }
}
