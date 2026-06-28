import type { JSX, ReactNode } from 'react'
import { cn } from 'react-kitchen-sink'
import { Checkbox } from 'react-tundraish'

import styles from './action-picker.module.css'

/** One selectable row: a CRUDS letter (v2) or a Read/Write component (v1). */
interface PickerItem {
  /** Stable id passed back to `onToggle` — a CRUDS letter or `'read'`/`'write'`. */
  readonly id: string
  /** The user-facing label (a verb, or "Read"/"Write"). */
  readonly label: ReactNode
  /** Optional mono scope value shown beside the label. */
  readonly code?: string
  readonly checked: boolean
  /** Locked-on (required by the app, or wildcard-covered) — not editable. */
  readonly locked: boolean
  /** Out of the request envelope — shown disabled, never hidden (`spec.md §2`). */
  readonly disabled: boolean
  /** Tooltip explaining a lock/disable. */
  readonly reason?: string | null
}

interface ActionPickerProps {
  readonly items: readonly PickerItem[]
  readonly onToggle: (id: string) => void
  /** Accessible name for the group (e.g. "Actions on Observation"). */
  readonly ariaLabel?: string
  /** Stack the rows (default) or lay them in a row (compact, for the grid). */
  readonly direction?: 'column' | 'row'
  /**
   * `boxed` (default) renders the design-system checkbox — used in the grid.
   * `plain` renders an un-boxed checklist (a ✓ when selected, nothing when not)
   * with the scope value right-aligned and the card sized to fit — the fluent
   * consent-list style.
   */
  readonly variant?: 'boxed' | 'plain'
  readonly className?: string
}

/**
 * The access multiselect — the one editor both SMART forms share. v2 scopes pass
 * the five CRUDS verbs (each with its mono letter, `spec.md §1`); v1 scopes pass
 * the two coarse parts **Read** and **Write** (both ⇒ `*`). A `locked` row is
 * checked + disabled (required / wildcard-covered), a `disabled` row is out of
 * the request envelope. See {@link ActionPickerProps.variant} for the boxed vs
 * plain looks.
 */
const ActionPicker = ({
  items,
  onToggle,
  ariaLabel,
  direction = 'column',
  variant = 'boxed',
  className,
}: ActionPickerProps): JSX.Element => (
  <div
    className={cn(
      styles['picker'],
      styles[`picker--${variant}`],
      direction === 'row' ? styles['picker--row'] : null,
      className
    )}
    role="group"
    aria-label={ariaLabel}
  >
    {items.map((item) => {
      const notEditable = item.locked || item.disabled
      if (variant === 'plain') {
        return (
          <label
            key={item.id}
            className={cn(styles['option'], notEditable ? styles['option--locked'] : null)}
            title={item.reason ?? undefined}
          >
            <input
              type="checkbox"
              className={styles['input']}
              checked={item.checked}
              disabled={notEditable}
              onChange={() => {
                onToggle(item.id)
              }}
            />
            <span aria-hidden="true" className={styles['check']}>
              ✓
            </span>
            <span className={styles['name']}>{item.label}</span>
            {item.code !== undefined ? <code className={styles['code']}>{item.code}</code> : null}
          </label>
        )
      }
      const boxedLabel = (
        <span className={styles['row']}>
          <span className={styles['name']}>{item.label}</span>
          {item.code !== undefined ? <code className={styles['code']}>{item.code}</code> : null}
        </span>
      )
      return (
        <span key={item.id} className={styles['cell']} title={item.reason ?? undefined}>
          {notEditable ? (
            <Checkbox checked={item.checked} disabled={true} label={boxedLabel} />
          ) : (
            <Checkbox
              checked={item.checked}
              onChange={() => {
                onToggle(item.id)
              }}
              label={boxedLabel}
            />
          )}
        </span>
      )
    })}
  </div>
)

export { ActionPicker, type ActionPickerProps, type PickerItem }
