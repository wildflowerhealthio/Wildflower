/**
 * `scopes-react` — reusable scope **list / pick / display** UI for Wildflower's
 * auth surfaces (device + app consent, service-request scope picking).
 * Presentational React components composed from `react-tundraish` primitives and
 * driven by the pure `scopes-core` model. Two synchronized projections of one
 * grant — plain-language consent statements and the resource×action grid —
 * sharing one access multiselect (CRUDS for v2, Read/Write for v1), plus flag
 * toggles, exclusions, and the subject selector.
 *
 * Laid out by atomic-design tier: `atoms/` are the single-control leaf widgets,
 * `molecules/` the shared access multiselect, `organisms/` the two full
 * projections (the grid + its model, and the statement).
 */

import './styles.css'

export { ContextCard, type ContextCardProps } from './atoms/context-card.tsx'
export { ExclusionRow, type ExclusionRowProps } from './atoms/exclusion-row.tsx'
export { FlagToggleRow, type FlagToggleRowProps } from './atoms/flag-toggle-row.tsx'
export {
  ActionPicker,
  type ActionPickerProps,
  type PickerItem,
} from './molecules/action-picker.tsx'
export {
  buildGridRows,
  type BuildGridRowsParams,
  type GridRow,
  type GridWordItem,
} from './organisms/grid-model.ts'
export { PermissionGrid, type PermissionGridProps } from './organisms/permission-grid.tsx'
export {
  PermissionStatement,
  type PermissionStatementProps,
} from './organisms/permission-statement.tsx'
