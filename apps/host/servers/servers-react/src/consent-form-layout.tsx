import { ErrorBanner } from '@wildflowerhealthio/react-tundraish'
import {
  type ConsentApproval,
  ConsentDetails,
  ConsentKey,
} from '@wildflowerhealthio/servers-core-js'
import type { JSX, ReactNode } from 'react'

import type { ConsentDecision } from './consent-queries.ts'
import styles from './consent-form-layout.module.css'

/** What each consent form takes, for its kind of `Details`. */
interface ConsentFormProps<Details extends ConsentDetails.Type> {
  /** The server the consent waits on. */
  readonly domain: string
  readonly details: Details
  /** Whether a decision is on its way to the host; the buttons wait for it. */
  readonly deciding: boolean
  /** Why the last decision failed; `null` when it didn't. */
  readonly decisionError: unknown
  readonly onDecide: (decision: ConsentDecision) => void
}

/** Props for {@link ConsentFormLayout}: the form's own, and what it fills the layout with. */
interface ConsentFormLayoutProps extends ConsentFormProps<ConsentDetails.Type> {
  /** The lines under the server that say where the request comes from, as `<p>`s. */
  readonly requestLines: ReactNode
  /** Whether the form's choices can be allowed as they stand. */
  readonly canAllow: boolean
  /** The approval of the form's choices as they stand, built when Allow is pressed. */
  readonly approval: () => ConsentApproval.Type
  /** The form's own choices, between the header and the actions. */
  readonly children: ReactNode
}

/**
 * What every consent form shares: who is asking and on which server, the
 * form's choices, why the last decision failed, and Deny or Allow.
 */
function ConsentFormLayout({
  domain,
  details,
  deciding,
  decisionError,
  onDecide,
  requestLines,
  canAllow,
  approval,
  children,
}: ConsentFormLayoutProps): JSX.Element {
  return (
    <div className={styles['consent-form-layout']}>
      <header className={styles['consent-form-layout__identity']}>
        <h3 className={styles['consent-form-layout__app']}>{ConsentDetails.appNameOf(details)}</h3>
        <p>
          wants access to <strong>{domain}</strong>
        </p>
        {requestLines}
        <code className={styles['consent-form-layout__client-id']}>{details.clientId}</code>
      </header>

      {children}

      <ErrorBanner error={decisionError} />

      <div className={styles['consent-form-layout__actions']}>
        <button
          type="button"
          className="button-2 outline accent-red"
          disabled={deciding}
          onClick={() => {
            onDecide({ kind: 'deny', consent: ConsentKey.of(details) })
          }}
        >
          Deny
        </button>
        <button
          type="button"
          className="button-2 filled"
          disabled={deciding || !canAllow}
          onClick={() => {
            onDecide({ kind: 'approve', approval: approval() })
          }}
        >
          Allow
        </button>
      </div>
    </div>
  )
}

export { ConsentFormLayout, type ConsentFormProps }
