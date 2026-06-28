import type { JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { Chip, StatusBadge } from 'react-tundraish'
import {
  ACTION_ORDER,
  bucketPrefix,
  VERB,
  WORD_COMPONENT_LABEL,
  type Action,
  type Bucket,
  type Cell,
  type WordComponent,
} from 'scopes-core'

import { ActionPicker, type PickerItem } from './action-picker.tsx'
import type { GridRow } from './grid-model.ts'
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
  readonly rows: readonly GridRow[]
  readonly onToggleCell: (bucket: Bucket, resource: string, action: Action) => void
  readonly onToggleWord: (bucket: Bucket, resource: string, component: WordComponent) => void
  /** The "current and future" note under the grid (shown when a wildcard row is present). */
  readonly wildcardNote?: string
  readonly className?: string
}

const GridCell = ({
  cell,
  label,
  onToggle,
}: {
  readonly cell: Cell
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
 * The resource × action matrix — the structured projection of a grant's resource
 * scopes. Columns are the five CRUDS verbs in canonical order (`spec.md §1`).
 * Each v2 row renders five cells in one of four states — **on**, **off**,
 * **locked** (required or wildcard-covered), **disabled** (out of envelope) —
 * computed in `scopes-core` (`buildCell`); v1 (`word`) rows render the same
 * {@link ActionPicker} as the consent view, with Read/Write in place of the
 * cells. The `✶ All record types` wildcard row drives the §3 locking below it.
 */
const PermissionGrid = ({
  title,
  chip,
  note,
  status,
  rows,
  onToggleCell,
  onToggleWord,
  wildcardNote,
  className,
}: PermissionGridProps): JSX.Element => (
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
          {ACTION_ORDER.map((action) => (
            <th key={action} scope="col" className={styles['col']}>
              <span className={styles['verb']}>{VERB[action]}</span>
              <code className={styles['letter']}>{action}</code>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const wordItems: PickerItem[] = (row.words ?? []).map((w) => ({
            id: w.component,
            label: WORD_COMPONENT_LABEL[w.component],
            code: w.component,
            checked: w.cell.state === 'on' || w.cell.state === 'locked',
            locked: w.cell.state === 'locked',
            disabled: w.cell.state === 'disabled',
            reason: w.cell.lockReason,
          }))
          return (
            <tr key={`${bucketPrefix(row.bucket)}/${row.resource}`} className={styles['row']}>
              <th scope="row" className={styles['rowhead']}>
                <span className={styles['label']}>{row.label}</span>
                <code className={styles['code']}>{row.code}</code>
              </th>
              {row.form === 'word' ? (
                <td colSpan={ACTION_ORDER.length} className={styles['word-cell']}>
                  <ActionPicker
                    items={wordItems}
                    direction="row"
                    ariaLabel={`Access for ${row.label}`}
                    onToggle={(id) => {
                      const item = (row.words ?? []).find((w) => w.component === id)
                      if (item !== undefined) onToggleWord(row.bucket, row.resource, item.component)
                    }}
                  />
                </td>
              ) : (
                (row.cells ?? []).map((cell, index) => {
                  const action = ACTION_ORDER[index] ?? 'r'
                  return (
                    <td key={action} className={styles['td']}>
                      <GridCell
                        cell={cell}
                        label={`${VERB[action]} ${row.label}`}
                        onToggle={() => {
                          onToggleCell(row.bucket, row.resource, action)
                        }}
                      />
                    </td>
                  )
                })
              )}
            </tr>
          )
        })}
      </tbody>
    </table>

    {wildcardNote !== undefined ? <p className={styles['wildcard-note']}>{wildcardNote}</p> : null}
  </section>
)

export { PermissionGrid, type PermissionGridProps }
