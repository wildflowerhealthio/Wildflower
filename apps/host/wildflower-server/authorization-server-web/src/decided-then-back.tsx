import type { JSX } from 'react'

import styles from './decided-then-back.module.css'

/**
 * How a request was settled: the Owner decided it here (`approved`,
 * `denied`), or it was no longer pending when the page read it (`elsewhere`:
 * decided in another browser, or expired).
 */
type Decision = 'approved' | 'denied' | 'elsewhere'

/** What a page in `then=back` mode says once the request is settled, by the decision. */
const DECIDED_MESSAGES: Readonly<Record<Decision, string>> = {
  approved: 'Approved. You can close this.',
  denied: 'Declined. You can close this.',
  elsewhere: 'This request was already decided or has expired. You can close this.',
}

interface DecidedThenBackProps {
  /** How the request was settled. */
  readonly decision: Decision
  /** The step back out of the page (see `goBackOnceDecidedOf`). */
  readonly goBack: () => void
}

/**
 * What a page in `then=back` mode shows once the request is settled: the
 * decision, and a Close button that steps back out of the page.
 *
 * @remarks
 * The page takes that step once by itself as the decision lands, so this shows
 * for long only when the step did nothing: there was no history entry to go
 * back to, and the browser refused to close a window no script opened. The
 * button tries again on the user's tap, and the message says the page can be
 * closed, for a browser that refuses that too.
 */
const DecidedThenBack = ({ decision, goBack }: DecidedThenBackProps): JSX.Element => (
  <>
    <p className={styles['decided-then-back__message']}>{DECIDED_MESSAGES[decision]}</p>
    <div className={styles['decided-then-back__actions']}>
      <button type="button" className="button-2 filled" onClick={goBack}>
        Close
      </button>
    </div>
  </>
)

export { DecidedThenBack }
