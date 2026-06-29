import { arrayMove } from '@dnd-kit/sortable'

import type { AppEntry } from '../../../queries.ts'

/**
 * Reorder the **full** app list by moving the dragged tile to the drop slot.
 *
 * `activeId`/`overId` are the dnd-kit ids of the dragged tile and the tile it was
 * dropped onto (both `AppEntry.id`s of *enabled* tiles, the only ones rendered).
 * The move is applied to the whole list — disabled apps keep their relative
 * slots — so the result is the complete new order to PUT to `/home-screen` (where
 * the array index becomes each row's `position`).
 *
 * Returns the new order, or `null` when nothing moved (a drop back onto the
 * origin, or an unknown id) so the caller skips the write.
 *
 * Pure — no dnd-kit state, no mutation — so the reorder math is unit-testable
 * without rendering a `DndContext`.
 */
export const reorderApps = (
  apps: readonly AppEntry[],
  activeId: string,
  overId: string
): readonly AppEntry[] | null => {
  if (activeId === overId) return null
  const from = apps.findIndex((app) => app.id === activeId)
  const to = apps.findIndex((app) => app.id === overId)
  if (from === -1 || to === -1) return null
  return arrayMove([...apps], from, to)
}
