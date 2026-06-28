import type { JSX, ReactNode } from 'react'
import { cn } from 'react-kitchen-sink'

import styles from './exclusion-row.module.css'

interface ExclusionRowProps {
  /** What won't be (or now will be) accessible, e.g. "Other health records". */
  readonly label: ReactNode
  /** Whether the thing is currently granted (✓) rather than excluded (✕). */
  readonly allowed: boolean
  /**
   * Whether this row can be widened in place via "+ Allow". Only true in open
   * mode — in request mode you can't widen past the envelope, so no affordance
   * is shown (`spec.md §8`).
   */
  readonly allowable: boolean
  /** Toggle the underlying permission in/out of the grant. */
  readonly onToggle: () => void
  readonly className?: string
}

/**
 * A curated "It won't be able to…" line (`spec.md §8`) — never an auto-computed
 * complement of the grant. Two states: **excluded** (✕, with an optional
 * "+ Allow" to widen the grant) and **allowed** (✓, with "Remove"). The action
 * appears only when the row is interactive (`allowable`, or already allowed).
 */
const ExclusionRow = ({
  label,
  allowed,
  allowable,
  onToggle,
  className,
}: ExclusionRowProps): JSX.Element => {
  // Both states share the same toggle button; only the label and visibility
  // differ (excluded-but-allowable widens, allowed removes).
  const showAction = allowed || allowable
  return (
    <div className={cn(styles['row'], allowed ? styles['allowed'] : styles['excluded'], className)}>
      <span className={styles['mark']} aria-hidden="true">
        {allowed ? '✓' : '✕'}
      </span>
      <span className={styles['label']}>{label}</span>
      {showAction ? (
        <button
          type="button"
          className={cn('button-1 outline', styles['action'])}
          onClick={onToggle}
        >
          {allowed ? 'Remove' : '+ Allow'}
        </button>
      ) : null}
    </div>
  )
}

export { ExclusionRow, type ExclusionRowProps }
