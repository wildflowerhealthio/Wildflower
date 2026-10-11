import { useId, useState, type JSX } from 'react'

import type { TunnelWithToken } from './queries/index.ts'
import styles from './tunnel-token-panel.module.css'

interface TunnelTokenPanelProps {
  /** What happened to the tunnel, e.g. `Created bob`. */
  readonly title: string
  readonly tunnel: TunnelWithToken
  /** The operator has the token; it is not shown again. */
  readonly onDone: () => void
}

/**
 * A tunnel with its token, just created or reissued: the one time the relay
 * shows it. Copy puts the token on the clipboard; Done drops it from the
 * page.
 */
const TunnelTokenPanel = ({ title, tunnel, onDone }: TunnelTokenPanelProps): JSX.Element => {
  const headingId = useId()
  const [copied, setCopied] = useState(false)
  const copy = async (): Promise<void> => {
    // The clipboard needs a focused, secure page and may still refuse; the
    // token is on screen to copy by hand either way.
    try {
      await navigator.clipboard.writeText(tunnel.token)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }
  return (
    <section className={styles['tunnel-token-panel']} aria-labelledby={headingId}>
      <h2 id={headingId} className="text-heading-3">
        {title}
      </h2>
      <p className="text-body-2">
        Visitors reach it at <code>https://{tunnel.public_host}</code>. Its device signs in with
        this token:
      </p>
      <code className={styles['tunnel-token-panel__token']} aria-label="Token">
        {tunnel.token}
      </code>
      <p className={styles['tunnel-token-panel__warning']}>
        This token won’t be shown again. Copy it now and give it to the tunnel’s owner.
      </p>
      <div className={styles['tunnel-token-panel__actions']}>
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

export { TunnelTokenPanel, type TunnelTokenPanelProps }
