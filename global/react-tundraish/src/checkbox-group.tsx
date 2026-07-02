import type { JSX, ReactNode } from 'react'
import { cn } from 'react-kitchen-sink'

import { Checkbox } from './checkbox.tsx'
import styles from './checkbox-group.module.css'

/** One selectable row in a {@link CheckboxGroup}. */
interface CheckboxGroupItem<TId extends string> {
  /** Stable id handed back to {@link CheckboxGroupProps.onToggle}. */
  readonly id: TId
  /** The user-facing label. */
  readonly label: ReactNode
  /** Optional mono value shown beside the label. */
  readonly code?: string
  readonly checked: boolean
  /** Checked but not editable (e.g. required or implied) — rendered disabled. */
  readonly locked: boolean
  /** Not applicable in the current context — shown disabled, never hidden. */
  readonly disabled: boolean
  /** Tooltip / accessible explanation for a lock or disable. */
  readonly reason?: string | null
}

interface CheckboxGroupProps<TId extends string> {
  readonly items: readonly CheckboxGroupItem<TId>[]
  readonly onToggle: (id: TId) => void
  /** Accessible name for the group (e.g. "Permissions on Observation"). */
  readonly ariaLabel?: string
  /** Stack the rows (default) or lay them out in a row (compact). */
  readonly direction?: 'column' | 'row'
  /**
   * `boxed` (default) renders the design-system checkbox. `plain` renders an
   * un-boxed checklist (a ✓ when selected, nothing when not) with any `code`
   * right-aligned and the card sized to fit.
   */
  readonly variant?: 'boxed' | 'plain'
  readonly className?: string
}

/**
 * A multi-select list of checkboxes. Each item is independently selectable; a
 * `locked` item is checked + disabled (selected but not editable), a `disabled`
 * item is inapplicable in the current context (shown, never hidden). See
 * {@link CheckboxGroupProps.variant} for the boxed vs plain looks.
 */
const CheckboxGroup = <TId extends string>({
  items,
  onToggle,
  ariaLabel,
  direction = 'column',
  variant = 'boxed',
  className,
}: CheckboxGroupProps<TId>): JSX.Element => (
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

export { CheckboxGroup, type CheckboxGroupProps, type CheckboxGroupItem }
