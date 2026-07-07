import type { JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { Chip, StatusBadge } from 'react-tundraish'
import type { Cell, Rows, Scope, Sections } from 'scopes-core'

import { PermissionPicker } from '../molecules/permission-picker.tsx'
import { pickerItemsFor } from '../molecules/picker-items.ts'
import styles from './permission-grid.module.css'

interface PermissionGridProps<K extends Scope.MultiScope.Kind> {
  /** Section heading (serif), e.g. "Health records". */
  readonly title: string
  /** Section tag chip, e.g. "FHIR" / "Admin". */
  readonly chip?: string
  /** Mono caption beside the title. */
  readonly note?: string
  /** Optional status badge, e.g. "No access". */
  readonly status?: string
  /** The section rendered — its configuration carries the interaction columns and layout. */
  readonly section: Sections.Section<K>
  /** The section's resolved rows ({@link Rows.build}). */
  readonly rows: readonly Rows.Row<K>[]
  /** Toggle one control on a row — a v2 interaction letter or a v1 `read`/`write` word. */
  readonly onToggleItem: (
    resource: Scope.MultiScope.ResourceOf<K>,
    itemId: Scope.MultiScope.InteractionOf<K>
  ) => void
  /** The "current and future" note under the grid (shown when a wildcard row is present). */
  readonly wildcardNote?: string
  readonly className?: string
}

const GridCell = ({
  state,
  reason,
  label,
  onToggle,
}: {
  readonly state: Cell.State
  readonly reason: string | null
  readonly label: string
  readonly onToggle: () => void
}): JSX.Element => {
  const checked = state === 'on' || state === 'locked'
  const interactive = state === 'on' || state === 'off'
  // Fold the reason into the accessible name so assistive tech conveys WHY a
  // cell can't change (a disabled <button>'s `title` tooltip isn't reachable).
  const accessibleName = reason === null ? label : `${label} — ${reason}`
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={accessibleName}
      disabled={!interactive}
      title={reason ?? undefined}
      className={cn(styles['cell'], styles[`cell--${state}`])}
      onClick={interactive ? onToggle : undefined}
    >
      <span aria-hidden="true" className={styles['glyph']}>
        {checked ? '✓' : ''}
      </span>
    </button>
  )
}

/**
 * The resource × interaction matrix — the structured projection of one grid section's
 * resource scopes. Columns come off the section's permission style in canonical order
 * (`spec.md §1`). Each `grid`-layout row renders one cell per column in
 * one of four states — **on**, **off**, **locked** (required or wildcard-covered),
 * **disabled** (out of scopeRequest) — resolved in `scopes-core` ({@link Rows.build}); an
 * `inline`-layout (v1 word) row renders a {@link PermissionPicker} spanning the columns.
 * Both forms emit the same `onToggleItem(resource, itemId)` callback (the section's
 * context is fixed, held by the container). The `✶ All record types` wildcard row drives
 * the §3 locking below it.
 */
const PermissionGrid = <K extends Scope.MultiScope.Kind>({
  title,
  chip,
  note,
  status,
  section,
  rows,
  onToggleItem,
  wildcardNote,
  className,
}: PermissionGridProps<K>): JSX.Element => {
  const { items: columns, layout } = section.configuration.permissionClass.empty
  return (
    <section className={cn(styles['grid'], className)}>
      <header className={styles['header']}>
        <h3 className={styles['title']}>{title}</h3>
        {chip !== undefined ? <Chip>{chip}</Chip> : null}
        {note !== undefined ? <code className={styles['note']}>{note}</code> : null}
        {status !== undefined ? <StatusBadge tone="neutral">{status}</StatusBadge> : null}
      </header>

      <table className={styles['table']}>
        <thead>
          <tr>
            <th className={styles['corner']} scope="col">
              <span className={styles['sr-only']}>Resource</span>
            </th>
            {columns.map((column) => (
              <th key={column.id} scope="col" className={styles['col']}>
                <span className={styles['verb']}>{column.name}</span>
                <code className={styles['letter']}>{column.code}</code>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const label = row.resource.singularLabel()
            const code =
              row.stored?.serialize() ??
              `${section.context.serialize()}/${row.resource.serialize()}`
            const items = pickerItemsFor(section.configuration, row)
            return (
              <tr key={row.resource.serialize()} className={styles['row']}>
                <th scope="row" className={styles['rowhead']}>
                  <span className={styles['label']}>{label}</span>
                  <code className={styles['code']}>{code}</code>
                </th>
                {layout === 'inline' ? (
                  <td colSpan={columns.length} className={styles['word-cell']}>
                    <PermissionPicker
                      items={items}
                      direction="row"
                      ariaLabel={`Access for ${label}`}
                      onToggle={(itemId) => {
                        onToggleItem(row.resource, itemId)
                      }}
                    />
                  </td>
                ) : (
                  items.map((item) => (
                    <td key={item.id} className={styles['td']}>
                      <GridCell
                        state={item.state}
                        reason={item.reason}
                        label={`${item.name} ${label}`}
                        onToggle={() => {
                          onToggleItem(row.resource, item.id)
                        }}
                      />
                    </td>
                  ))
                )}
              </tr>
            )
          })}
        </tbody>
      </table>

      {wildcardNote !== undefined ? (
        <p className={styles['wildcard-note']}>{wildcardNote}</p>
      ) : null}
    </section>
  )
}

export { PermissionGrid, type PermissionGridProps }
