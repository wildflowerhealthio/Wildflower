/**
 * `pickerItemsFor` — resolve one `scopes-core` {@link Rows.Row} into the
 * {@link PickerItem}s the {@link PermissionPicker} (and the grid's cells) render. Lives
 * apart from the picker component so the component file exports only components
 * (fast-refresh rule).
 */
import type { Cell, Rows, Scope } from 'scopes-core'

import type { PickerItem } from './permission-picker.tsx'

/**
 * Resolve one {@link Rows.Row} into its picker items: the section's permission style
 * items in display order, each with its resolved cell state and the user-facing lock
 * copy. The §2/§3 lock *decisions* come from `scopes-core` ({@link Cell.LockReason});
 * only the sentences live here. The wildcard row's own label ("✶ All record types")
 * comes from the domain, so the wildcard lock copy doesn't duplicate it.
 */
const pickerItemsFor = <K extends Scope.MultiScope.Kind>(
  configuration: Scope.MultiScope.ResourceScopeConfigurationFor<K>,
  row: Rows.Row<K>
): readonly PickerItem<Scope.MultiScope.InteractionOf<K>>[] => {
  const wildcardLabel =
    configuration.resourceClass.wildcardResourceType?.pluralLabel() ?? 'all record types'
  // Keyed by every {@link Cell.LockReason} kind, so the map stays exhaustive — a new
  // kind is a compile error until it's given copy.
  const lockCopy: Record<Cell.LockReason['kind'], string> = {
    wildcard: `Granted by the ${wildcardLabel} row — change it there`,
    required: 'Required by the app',
    notRequested: 'Not requested by the app',
  }
  return configuration.permissionClass.empty.items.map((item) => {
    const cell = row.cellFor(item.id)
    return {
      id: item.id,
      name: item.name,
      code: item.code,
      state: cell.state,
      reason: cell.lockReason === null ? null : lockCopy[cell.lockReason.kind],
    }
  })
}

export { pickerItemsFor }
