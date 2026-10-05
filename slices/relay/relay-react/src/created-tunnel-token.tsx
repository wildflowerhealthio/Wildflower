import { useId, useState, type JSX } from 'react'

import type { CreatedTunnel } from './queries/index.ts'
import styles from './created-tunnel-token.module.css'

interface CreatedTunnelTokenProps {
  readonly created: CreatedTunnel
  /** The operator has the token; it is not shown again. */
  readonly onDone: () => void
}

/**
 * A tunnel just created, with its token: the one time the relay shows it.
 * Copy puts the token on the clipboard; Done drops it from the page.
 */
const CreatedTunnelToken = ({ created, onDone }: CreatedTunnelTokenProps): JSX.Element => {
  const headingId = useId()
  const [copied, setCopied] = useState(false)
  const copy = async (): Promise<void> => {
    // The clipboard needs a focused, secure page and may still refuse; the
    // token is on screen to copy by hand either way.
    try {
      await navigator.clipboard.writeText(created.token)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }
  return (
    <section className={styles['created-tunnel-token']} aria-labelledby={headingId}>
      <h3 id={headingId} className="text-heading-3">
        Created {created.name}
      </h3>
      <p className="text-body-2">
        Visitors reach it at <code>https://{created.public_host}</code>. Its device signs in with
        this token:
      </p>
      <code className={styles['created-tunnel-token__token']} aria-label="Token">
        {created.token}
      </code>
      <p className={styles['created-tunnel-token__warning']}>
        This token won’t be shown again. Copy it now and give it to the tunnel’s owner.
      </p>
      <div className={styles['created-tunnel-token__actions']}>
        <button
          type="button"
          className="button-2 outline"
          onClick={() => {
            void copy()
          }}
        >
          {copied ? 'Copied' : 'Copy token'}
        </button>
        <button type="button" className="button-2 filled" onClick={onDone}>
          Done
        </button>
      </div>
    </section>
  )
}

export { CreatedTunnelToken, type CreatedTunnelTokenProps }
