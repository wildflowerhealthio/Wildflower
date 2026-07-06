/**
 * `scopes-react` — reusable scope **list / pick / display** UI for Wildflower's
 * auth surfaces (device + app consent, service-request scope picking).
 * Presentational React components composed from `react-tundraish` primitives and
 * driven by the pure `scopes-core` model. Two synchronized projections of one
 * grant — plain-language consent statements and the resource×interaction grid —
 * sharing one form-agnostic permission picker (driven by a `scopes-core`
 * permission style — interactions for v2, Read/Write for v1), plus flag toggles,
 * exclusions, and the subject selector.
 *
 * Laid out by atomic-design tier: `atoms/` are the single-control leaf widgets,
 * `molecules/` the permission picker (built on react-tundraish's `CheckboxGroup`),
 * `organisms/` the two full projections (the grid + its model, and the statement).
 */

export { ContextCard, type ContextCardProps } from './atoms/context-card.tsx'
export { ExclusionRow, type ExclusionRowProps } from './atoms/exclusion-row.tsx'
export { FlagToggleRow, type FlagToggleRowProps } from './atoms/flag-toggle-row.tsx'
export {
  PermissionPicker,
  type PickerItem,
  type PermissionPickerProps,
} from './molecules/permission-picker.tsx'
export * as Grid from './organisms/grid-model.ts'
export { PermissionGrid, type PermissionGridProps } from './organisms/permission-grid.tsx'
export {
  PermissionStatement,
  type PermissionStatementProps,
} from './organisms/permission-statement.tsx'
