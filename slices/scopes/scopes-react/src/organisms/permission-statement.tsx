import type { JSX, ReactNode } from 'react'
import { cn } from 'react-kitchen-sink'
import { StatusBadge } from 'react-tundraish'

import { ActionPicker, type PickerItem } from '../molecules/action-picker.tsx'
import styles from './permission-statement.module.css'

interface PermissionStatementProps {
  /** Lead phrase, e.g. "Fitbit Sync can", "It can also", "This device can". */
  readonly subjectPhrase: ReactNode
  /** Small joining word between the verb token and the resource ("your"), or none. */
  readonly connector?: ReactNode
  /** The access summary token text, e.g. "Read · Create" — tap to edit. */
  readonly verbText: string
  /** The 1:1 resource label, or "✶ everything" for the wildcard. */
  readonly resourceLabel: ReactNode
  /**
   * The access multiselect rows shown when expanded. The same shape for both
   * SMART forms — five CRUDS verbs (v2) or Read/Write (v1) — so the statement
   * doesn't care which it's editing.
   */
  readonly items: readonly PickerItem[]
  readonly onToggleItem: (id: string) => void
  /** Whether the inline access editor is expanded. */
  readonly open: boolean
  readonly onToggleOpen: () => void
  /** Show a "Required" badge (request mode, required scope — not removable). */
  readonly required?: boolean
  /** Show a "Remove" control (optional/open-mode scope). */
  readonly removable?: boolean
  readonly onRemove?: () => void
  /** Helper line under the editor. */
  readonly note?: ReactNode
  readonly className?: string
}

/**
 * The plain-language consent row — one sentence that reads
 * "*\<subject\> can* **\<verbs\>** *\<connector\>* **\<resource\>**", with the
 * verbs token tappable to open the inline access multiselect ({@link
 * ActionPicker}). The same picker edits a v2 (CRUDS) or v1 (Read/Write) scope —
 * the statement just renders whatever items it's given. Technical scope strings
 * never appear here (plain language only, `spec.md §10`).
 */
const PermissionStatement = ({
  subjectPhrase,
  connector,
  verbText,
  resourceLabel,
  items,
  onToggleItem,
  open,
  onToggleOpen,
  required = false,
  removable = false,
  onRemove,
  note,
  className,
}: PermissionStatementProps): JSX.Element => {
  // The right-side affordance: a "Required" badge (locked), or a "Remove"
  // control, or nothing — kept out of the JSX to avoid a nested ternary.
  let trailing: JSX.Element | null = null
  if (required) {
    trailing = (
      <StatusBadge tone="neutral" className={styles['badge']}>
        Required
      </StatusBadge>
    )
  } else if (removable && onRemove !== undefined) {
    trailing = (
      <button type="button" className={cn('button-1 outline', styles['remove'])} onClick={onRemove}>
        Remove
      </button>
    )
  }

  return (
    <div className={cn(styles['statement'], className)}>
      <p className={styles['sentence']}>
        <span className={styles['subject']}>{subjectPhrase}</span>{' '}
        <button
          type="button"
          className={cn(styles['verb-token'], open ? styles['verb-token--open'] : null)}
          aria-expanded={open}
          onClick={onToggleOpen}
        >
          <span className={styles['verb-text']}>{verbText}</span>
          <span aria-hidden="true" className={styles['caret']}>
            {open ? '▴' : '▾'}
          </span>
        </button>{' '}
        {connector !== undefined ? <span className={styles['connector']}>{connector} </span> : null}
        <span className={styles['resource-token']}>{resourceLabel}</span>
        <span className={styles['trailing']}>{trailing}</span>
      </p>

      {open ? (
        <div className={styles['editor']}>
          <ActionPicker
            items={items}
            onToggle={onToggleItem}
            variant="plain"
            ariaLabel="Edit access"
          />
          {note !== undefined ? <p className={styles['note']}>{note}</p> : null}
        </div>
      ) : null}
    </div>
  )
}

export { PermissionStatement, type PermissionStatementProps }
