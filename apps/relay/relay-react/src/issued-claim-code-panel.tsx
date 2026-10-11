import { DateTime } from 'effect'
import { useId, useState, type JSX } from 'react'

import type { IssuedClaimCode } from './queries/index.ts'
import styles from './issued-claim-code-panel.module.css'

interface IssuedClaimCodePanelProps {
  /** The tunnel the code was issued for. */
  readonly tunnelName: string
  readonly issued: IssuedClaimCode
  /** The operator has the code; it is not shown again. */
  readonly onDone: () => void
}

/**
 * A claim code just issued for a tunnel: the one time the relay shows it.
 * The tunnel's owner types it into their device, which redeems it once,
 * before it expires, for the tunnel's name and token. It cancels the
 * tunnel's earlier code. Copy puts the code on
 * the clipboard; Done drops it from the page.
 */
const IssuedClaimCodePanel = ({
  tunnelName,
  issued,
  onDone,
}: IssuedClaimCodePanelProps): JSX.Element => {
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
    <section className={styles['issued-claim-code-panel']} aria-labelledby={headingId}>
      <h3 id={headingId} className="text-heading-4">
        Claim code for {tunnelName}
      </h3>
      <code className={styles['issued-claim-code-panel__code']} aria-label="Claim code">
        {issued.code}
      </code>
      <p className="text-body-2">
        Its device redeems it once for the tunnel’s name and token. It expires at{' '}
        <time dateTime={DateTime.formatIso(issued.expires_at)}>
          {DateTime.formatLocal(issued.expires_at, { timeStyle: 'short' })}
        </time>
        . Any code issued for this tunnel before it no longer works.
      </p>
      <p className={styles['issued-claim-code-panel__warning']}>
        This code won’t be shown again. Give it to the tunnel’s owner now.
      </p>
      <div className={styles['issued-claim-code-panel__actions']}>
        <button
          type="button"
          className="button-2 outline"
          onClick={() => {
            void copy()
          }}
        >
          {copied ? 'Copied' : 'Copy code'}
        </button>
        <button type="button" className="button-2 filled" onClick={onDone}>
          Done
        </button>
      </div>
    </section>
  )
}

export { IssuedClaimCodePanel, type IssuedClaimCodePanelProps }
