import {
  invitationMailtoOf,
  type ClaimCodeTarget,
} from '@wildflowerhealthio/relay-core-js/invitations'
import { DateTime } from 'effect'
import { useId, useState, type JSX, type ReactNode } from 'react'

import type { IssuedClaimCode } from './queries/index.ts'
import styles from './issued-code-panel.module.css'

interface IssuedCodePanelProps {
  /** The panel's heading, saying what the code is for. */
  readonly title: string
  readonly issued: IssuedClaimCode
  /** What the code redeems for, which the invitation email explains. */
  readonly target: ClaimCodeTarget
  /** Who the operator gives the code to, ending the warning. */
  readonly recipient: string
  /** What the code redeems for, before the expiry. */
  readonly children: ReactNode
  /** The operator has the code; it is not shown again. */
  readonly onDone: () => void
}

/**
 * A claim code just issued: the one time the relay shows it,
 * with what it redeems for and when it expires. Copy puts the code on the
 * clipboard; Email opens a draft invitation with the code and how to install
 * Wildflower, addressed to no one; Done drops it from the page.
 */
const IssuedCodePanel = ({
  title,
  issued,
  target,
  recipient,
  children,
  onDone,
}: IssuedCodePanelProps): JSX.Element => {
  const headingId = useId()
  const [copied, setCopied] = useState(false)
  const copy = async (): Promise<void> => {
    // The clipboard needs a focused, secure page and may still refuse; the
    // code is on screen to copy by hand either way.
    try {
      await navigator.clipboard.writeText(issued.code)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }
  return (
    <section className={styles['issued-code-panel']} aria-labelledby={headingId}>
      <h3 id={headingId} className="text-heading-4">
        {title}
      </h3>
      <code className={styles['issued-code-panel__code']} aria-label="Claim code">
        {issued.code}
      </code>
      <p className="text-body-2">
        {children} It expires at{' '}
        <time dateTime={DateTime.formatIso(issued.expires_at)}>
          {DateTime.formatLocal(issued.expires_at, { dateStyle: 'medium', timeStyle: 'short' })}
        </time>
        .
      </p>
      <p className={styles['issued-code-panel__warning']}>
        This code won’t be shown again. Give it to {recipient} now.
      </p>
      <div className={styles['issued-code-panel__actions']}>
        <button
          type="button"
          className="button-2 outline"
          onClick={() => {
            void copy()
          }}
        >
          {copied ? 'Copied' : 'Copy code'}
        </button>
        <a
          className="button-2 outline"
          href={invitationMailtoOf(issued, target, DateTime.zoneMakeLocal())}
        >
          Email code
        </a>
        <button type="button" className="button-2 filled" onClick={onDone}>
          Done
        </button>
      </div>
    </section>
  )
}

export { IssuedCodePanel, type IssuedCodePanelProps }
