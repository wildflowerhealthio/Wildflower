import type { JSX, ReactNode } from 'react'
import { cn } from 'react-kitchen-sink'
import { StatusBadge } from 'react-tundraish'

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
   * The inline permission editor shown when expanded — the consumer supplies a
   * `PermissionPicker` built from the row's permission style (v2 cells or v1
   * Read/Write words), so the statement stays agnostic to which form it edits.
   */
  readonly children: ReactNode
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
 * verbs token tappable to reveal the inline permission editor supplied as
 * `children` (a `PermissionPicker`). The statement stays agnostic to which form
 * it edits. Technical scope strings never appear here (plain language only,
 * `spec.md §10`).
 */
const PermissionStatement = ({
  subjectPhrase,
  connector,
  verbText,
  resourceLabel,
  children,
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
          {children}
          {note !== undefined ? <p className={styles['note']}>{note}</p> : null}
        </div>
      ) : null}
    </div>
  )
}

export { PermissionStatement, type PermissionStatementProps }
