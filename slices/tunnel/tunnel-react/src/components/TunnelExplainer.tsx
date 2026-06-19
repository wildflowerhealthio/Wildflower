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
        <strong className={styles['explainer__host']}>{state.publicHost}</strong>. Anyone who you
        haven&apos;t granted access to will need to ask your permission through the app.
      </p>
    ) : (
      <p className={styles['explainer']}>
        Apps and people you&apos;ve authorized can access your device. Anyone who you haven&apos;t
        granted access to will need to ask your permission through the app.
      </p>
    )
  }
  return (
    <p className={styles['explainer']}>
      By default, your personal health record is only accessible on this device. By activating the
      tunnel you can use Wildflower from your computer, use apps that access your data remotely, or
      share access with anyone in your circle of care. You need to specifically grant any user or
      app access from the Wildflower app on your device.
    </p>
  )
}

export { TunnelExplainer }
export type { TunnelExplainerProps }
