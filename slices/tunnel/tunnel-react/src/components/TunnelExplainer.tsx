import type { JSX, ReactNode } from 'react'

import { mightTunnelBeOpen, type TunnelState } from '../queries.ts'
import styles from './TunnelExplainer.module.css'

interface TunnelExplainerProps {
  readonly state: TunnelState
}

type ExplainerVariant = 'open-host' | 'open-no-host' | 'closed'

const deriveVariant = (state: TunnelState): ExplainerVariant => {
  if (!mightTunnelBeOpen(state)) return 'closed'
  return state.publicHost !== null ? 'open-host' : 'open-no-host'
}

const renderCopy = (variant: ExplainerVariant, publicHost: string | null): ReactNode => {
  if (variant === 'open-host' && publicHost !== null) {
    return (
      <>
        Apps and people you&apos;ve authorized can access your device at{' '}
        <strong className={styles['explainer__host']}>{publicHost}</strong>.<br />
        Apps and devices can only access your personal health record with your explicit permission
        &mdash; granted through the Wildflower app.
      </>
    )
  }
  if (variant === 'open-no-host') {
    return (
      <>
        Apps and people you&apos;ve authorized can access your device. Apps and devices will still
        need to ask your permission through the app to get access.
      </>
    )
  }
  return (
    <>
      By default, your personal health record is only accessible on this device. <br /> By
      activating the tunnel you can use apps that access your data remotely, or grant access from
      another device.
    </>
  )
}

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
 *
 * The variant is keyed onto the `<p>` so React remounts the paragraph
 * across copy swaps; a CSS keyframe on `.explainer` plays on mount,
 * giving the new copy a brief fade-up rather than the previous instant
 * text replacement. The host string isn't keyed (only the variant is),
 * so updating just `publicHost` doesn't restart the animation — the
 * emphasized host re-renders in place.
 */
const TunnelExplainer = ({ state }: TunnelExplainerProps): JSX.Element => {
  const variant = deriveVariant(state)
  return (
    <p key={variant} className={styles['explainer']}>
      {renderCopy(variant, state.publicHost)}
    </p>
  )
}

export { TunnelExplainer }
export type { TunnelExplainerProps }
