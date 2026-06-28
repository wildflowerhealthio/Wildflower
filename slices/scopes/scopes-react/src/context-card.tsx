import type { JSX, ReactNode } from 'react'
import { cn } from 'react-kitchen-sink'

import styles from './context-card.module.css'

interface ContextCardProps {
  /** The choice's title, e.g. "Just this patient" / "All patients". */
  readonly label: ReactNode
  /** Secondary description under the title. */
  readonly sublabel?: ReactNode
  /** The scope context this maps to, shown in mono (e.g. `patient/`, `system/`). */
  readonly code?: string
  readonly selected: boolean
  /** Optional neutral marker chip (e.g. a `StatusBadge` reading "Everyone"). */
  readonly badge?: ReactNode
  readonly onSelect: () => void
  readonly className?: string
}

/**
 * A subject selector card — one option in a one-patient / all-patients choice.
 * Behaves as a radio (mount a set inside a `role="radiogroup"`); all options
 * carry equal, neutral weight (the broader `system/` choice is a legitimate
 * pick, not a destructive one — its step-up re-auth is handled by the flow, not
 * by alarm styling). The selection ring is painted as an overlay toggled by a
 * class rather than a dynamic border, so first paint never waits on a computed
 * style.
 */
const ContextCard = ({
  label,
  sublabel,
  code,
  selected,
  badge,
  onSelect,
  className,
}: ContextCardProps): JSX.Element => (
  <button
    type="button"
    role="radio"
    aria-checked={selected}
    className={cn(styles['card'], selected ? styles['selected'] : null, className)}
    onClick={onSelect}
  >
    {selected ? <span className={styles['ring']} aria-hidden="true" /> : null}
    <span className={styles['header']}>
      <span className={styles['title']}>{label}</span>
      {badge !== undefined ? <span className={styles['badge']}>{badge}</span> : null}
    </span>
    {sublabel !== undefined ? <span className={styles['sublabel']}>{sublabel}</span> : null}
    {code !== undefined ? <code className={styles['code']}>{code}</code> : null}
  </button>
)

export { ContextCard, type ContextCardProps }
