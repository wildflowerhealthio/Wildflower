import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { cn } from 'react-kitchen-sink'
import { StatusBadge } from 'react-tundraish'

import styles from './permission-statement.module.css'

interface PermissionStatementProps {
  /**
   * Lead phrase, e.g. "Fitbit Sync can", "It can also". Omit it for a
   * follow-on row in a long list — the sentence then starts at the verb
   * token with a minimal "…and" connector supplied by the caller as
   * `subjectPhrase` when desired.
   */
  readonly subjectPhrase?: ReactNode
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
 * "*\<subject\> can* **\<verbs\>** *\<connector\>* **\<resource\>**", led by a
 * ✓ mark. The permission editor supplied as `children` (a `PermissionPicker`)
 * shows in a floating popover card while the pointer hovers the row and pins
 * open on a verbs-token click.
 * The statement stays agnostic to which form it edits. Technical scope
 * strings never appear here (plain language only, `spec.md §10`).
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
  const rootRef = useRef<HTMLDivElement>(null)
  // Hover peeking: the editor also shows while the pointer rests on the row,
  // without touching the controlled `open` (the click-pinned state). Entering
  // the floating editor itself keeps it open — it's inside the root.
  const [hovered, setHovered] = useState(false)
  const expanded = open || hovered

  // Dismiss the floating editor on an outside press — same idiom as the
  // design-system Menu. `onToggleOpen` closes because the row is open.
  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (event: PointerEvent): void => {
      const node = rootRef.current
      const target = event.target
      if (node !== null && target instanceof Node && !node.contains(target)) {
        onToggleOpen()
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return (): void => {
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [open, onToggleOpen])

  // The right-side affordance: a "Required" badge (locked), or a "Remove"
  // control, or nothing — kept out of the JSX to avoid a nested ternary.
  let trailing: JSX.Element | null = null
  if (required) {
    trailing = <StatusBadge tone="neutral">Required</StatusBadge>
  } else if (removable && onRemove !== undefined) {
    trailing = (
      <button type="button" className={styles['remove']} onClick={onRemove}>
        Remove
      </button>
    )
  }

  return (
    <div ref={rootRef} className={cn(styles['statement'], className)}>
      <span aria-hidden="true" className={styles['mark']}>
        ✓
      </span>
      <div className={styles['content']}>
        {/* A <div> (not <p>): the floating editor nests inside the verb anchor,
            and block content inside <p> would make the browser re-parent it. */}
        <div className={styles['sentence']}>
          {subjectPhrase !== undefined ? (
            <span className={styles['subject']}>{subjectPhrase} </span>
          ) : null}
          {/* The hover target is exactly the pill (plus the open editor, a
              descendant — leaving into it keeps the popover up). */}
          <span
            className={styles['verb-anchor']}
            onMouseEnter={() => {
              setHovered(true)
            }}
            onMouseLeave={() => {
              setHovered(false)
            }}
          >
            <button
              type="button"
              className={cn(styles['verb-token'], expanded ? styles['verb-token--open'] : null)}
              aria-expanded={expanded}
              onClick={onToggleOpen}
            >
              {verbText}
              <span aria-hidden="true" className={styles['caret']}>
                {expanded ? '▴' : '▾'}
              </span>
            </button>
            {expanded ? (
              <div className={styles['editor']}>
                <p className={styles['editor-eyebrow']}>Actions</p>
                {children}
                {note !== undefined ? <p className={styles['note']}>{note}</p> : null}
              </div>
            ) : null}
          </span>{' '}
          {connector !== undefined ? (
            <span className={styles['connector']}>{connector} </span>
          ) : null}
          <span className={styles['resource-token']}>{resourceLabel}</span>
        </div>
      </div>
      {trailing !== null ? <span className={styles['trailing']}>{trailing}</span> : null}
    </div>
  )
}

export { PermissionStatement, type PermissionStatementProps }
