import type { JSX } from 'react'

import { LinkButton } from './link-button.tsx'
import styles from './gate-card.module.css'

interface GateCardProps {
  readonly title: string
  readonly body?: string
  /** `false` renders the paused variant — same card, no spinner. */
  readonly showSpinner?: boolean
  /** An optional link-text escape/retry under the copy. */
  readonly action?: { readonly label: string; readonly onClick: () => void }
}

/**
 * A centered **loader card** for a body that cannot render until something
 * finishes loading: a spinner ring, a short title, an optional explanation,
 * and an optional link-text action (an escape hatch or a retry). With
 * `showSpinner: false` it is the paused variant — the same card explaining
 * why the body is empty when nothing is actually running.
 *
 * The card is a `role="status"` region so the title is announced politely
 * when the gate appears.
 */
const GateCard = ({ title, body, showSpinner = true, action }: GateCardProps): JSX.Element => (
  <div className={styles['card']} role="status">
    {showSpinner && <span aria-hidden="true" className={styles['spinner']} />}
    <p className={styles['title']}>{title}</p>
    {body !== undefined && <p className={styles['body']}>{body}</p>}
    {action !== undefined && (
      <LinkButton className={styles['action']} onClick={action.onClick}>
        {action.label}
      </LinkButton>
    )}
  </div>
)

export { GateCard }
export type { GateCardProps }
