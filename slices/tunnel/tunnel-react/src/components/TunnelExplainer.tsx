import type { JSX } from 'react'

import type { TunnelState } from '../queries.ts'
import styles from './TunnelExplainer.module.css'

interface TunnelExplainerProps {
  readonly state: TunnelState
}

/*
 * `running || requestedRunning` errs toward the "open" copy: during a
 * stop transition (requestedRunning=false, running=true) and during a
 * start transition (requestedRunning=true, running=false) the device is
 * still reachable or about to be, so the open-state copy is the safer
 * truth to tell the user.
 */
const isOpen = (state: TunnelState): boolean => state.running || state.requestedRunning

/**
 * State-aware explainer paragraph rendered beneath the Tunnel screen's
 * `<PageHeader>`. The copy swaps between three branches:
 *
 *   - "open with host" — the daemon is (or is becoming) reachable and a
 *     public host is configured; the host is emphasized in the copy.
 *   - "open without host" — the daemon is (or is becoming) reachable but
 *     no public host has been set yet; the same sentence runs without the
 *     trailing "at {host}" clause rather than rendering an awkward gap.
 *   - "closed" — the resting state, describing the opt-in nature of the
 *     tunnel.
 */
const TunnelExplainer = ({ state }: TunnelExplainerProps): JSX.Element => {
  if (isOpen(state)) {
    return state.publicHost !== null ? (
      <p className={styles['explainer']}>
        Apps and people you&apos;ve authorized can access your device at{' '}
        <strong className={styles['explainer__host']}>{state.publicHost}</strong>.<br />
        Apps and devices can only access your personal health record with your explicit permission
        &mdash; granted through the Wildflower app.
      </p>
    ) : (
      <p className={styles['explainer']}>
        Apps and people you&apos;ve authorized can access your device. Apps and devices will still
        need to ask your permission through the app to get access.
      </p>
    )
  }
  return (
    <p className={styles['explainer']}>
      By default, your personal health record is only accessible on this device. <br /> By
      activating the tunnel you can use use apps that access your data remotely, or grant access
      from another device.
    </p>
  )
}

export { TunnelExplainer }
export type { TunnelExplainerProps }
