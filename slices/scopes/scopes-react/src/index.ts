/**
 * `scopes-react` — reusable scope **list / pick / display** UI for Wildflower's
 * auth surfaces (device + app consent, service-request scope picking).
 * Presentational React components composed from `react-tundraish` primitives and
 * driven by the pure `scopes-core` model. Two synchronized projections of one
 * grant — plain-language consent statements and the resource×action grid —
 * sharing one access multiselect (CRUDS for v2, Read/Write for v1), plus flag
 * toggles, exclusions, and the subject selector.
 */

import './styles.css'

export { ActionPicker, type ActionPickerProps, type PickerItem } from './action-picker.tsx'
export { ContextCard, type ContextCardProps } from './context-card.tsx'
export { ExclusionRow, type ExclusionRowProps } from './exclusion-row.tsx'
export { FlagToggleRow, type FlagToggleRowProps } from './flag-toggle-row.tsx'
export {
  buildGridRows,
  type BuildGridRowsParams,
  type GridRow,
  type GridWordItem,
} from './grid-model.ts'
export { PermissionGrid, type PermissionGridProps } from './permission-grid.tsx'
export { PermissionStatement, type PermissionStatementProps } from './permission-statement.tsx'
