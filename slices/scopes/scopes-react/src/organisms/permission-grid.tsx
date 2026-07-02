import type { JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { Chip, StatusBadge } from 'react-tundraish'
import type { Cell } from 'scopes-core'

import { PermissionPicker } from '../molecules/permission-picker.tsx'
import type { Grid } from './grid-model.ts'
import styles from './permission-grid.module.css'

interface PermissionGridProps {
  /** Section heading (serif), e.g. "Health records". */
  readonly title: string
  /** Section tag chip, e.g. "FHIR" / "Admin". */
  readonly chip?: string
  /** Mono caption beside the title. */
  readonly note?: string
  /** Optional status badge, e.g. "No access". */
  readonly status?: string
  /** The projected section — its interaction columns + rows (from `buildGrid`). */
  readonly grid: Grid
  /** Toggle one control on a row — a v2 interaction letter or a v1 `read`/`write` word. */
  readonly onToggleItem: (resource: string, itemId: string) => void
  /** The "current and future" note under the grid (shown when a wildcard row is present). */
  readonly wildcardNote?: string
  readonly className?: string
}

const GridCell = ({
  cell,
  label,
  onToggle,
}: {
  readonly cell: Cell.Cell
  readonly label: string
  readonly onToggle: () => void
}): JSX.Element => {
  const checked = cell.state === 'on' || cell.state === 'locked'
  const interactive = cell.state === 'on' || cell.state === 'off'
  // Fold the reason into the accessible name so assistive tech conveys WHY a
  // cell can't change (a disabled <button>'s `title` tooltip isn't reachable).
  const accessibleName = cell.lockReason === null ? label : `${label} — ${cell.lockReason}`
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={accessibleName}
      disabled={!interactive}
      title={cell.lockReason ?? undefined}
      className={cn(styles['cell'], styles[`cell--${cell.state}`])}
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
 * resource scopes. Columns are the section's interaction columns in canonical order
 * (`spec.md §1`), supplied as data. Each `grid`-layout row renders one cell per column in
 * one of four states — **on**, **off**, **locked** (required or wildcard-covered),
 * **disabled** (out of scopeRequest) — resolved in `scopes-core` (`Cell.forItem`); an
 * `inline`-layout (v1 word) row renders a {@link PermissionPicker} spanning the columns.
 * Both forms emit the same `onToggleItem(resource, itemId)` callback (the section's
 * context is fixed, held by the container). The `✶ All record types` wildcard row drives
 * the §3 locking below it.
 */
const PermissionGrid = ({
  title,
  chip,
  note,
  status,
  grid,
  onToggleItem,
  wildcardNote,
  className,
}: PermissionGridProps): JSX.Element => {
  const { columns, rows } = grid
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
          {rows.map((row) => (
            <tr key={row.resource} className={styles['row']}>
              <th scope="row" className={styles['rowhead']}>
                <span className={styles['label']}>{row.label}</span>
                <code className={styles['code']}>{row.code}</code>
              </th>
              {row.layout === 'inline' ? (
                <td colSpan={columns.length} className={styles['word-cell']}>
                  <PermissionPicker
                    items={row.items}
                    direction="row"
                    ariaLabel={`Access for ${row.label}`}
                    onToggle={(itemId) => {
                      onToggleItem(row.resource, itemId)
                    }}
                  />
                </td>
              ) : (
                row.items.map((item) => (
                  <td key={item.id} className={styles['td']}>
                    <GridCell
                      cell={item.cell}
                      label={`${item.name} ${row.label}`}
                      onToggle={() => {
                        onToggleItem(row.resource, item.id)
                      }}
                    />
                  </td>
                ))
              )}
            </tr>
          ))}
        </tbody>
      </table>

      {wildcardNote !== undefined ? (
        <p className={styles['wildcard-note']}>{wildcardNote}</p>
      ) : null}
    </section>
  )
}

export { PermissionGrid, type PermissionGridProps }
