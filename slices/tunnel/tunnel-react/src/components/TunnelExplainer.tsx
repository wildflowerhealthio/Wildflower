import type { JSX, ReactNode } from 'react'

import type { TunnelState } from '../queries/index.ts'
import styles from './TunnelExplainer.module.css'

interface TunnelExplainerProps {
  readonly state: TunnelState
}

type ExplainerVariant = 'open' | 'closed'

const deriveVariant = (state: TunnelState): ExplainerVariant =>
  state.status === 'off' ? 'closed' : 'open'

const renderCopy = (variant: ExplainerVariant, publicHost: string): ReactNode => {
  if (variant === 'open') {
    return (
      <>
        Apps and people you&apos;ve authorized can access your device at{' '}
        <strong className={styles['explainer__host']}>{publicHost}</strong>.<br />
        Apps and devices can only access your personal health record with your explicit permission
        &mdash; granted through the Wildflower app.
      </>
    )
  }
  return <>This server has no tunnel, so your personal health record is only accessible on it.</>
}

/**
 * State-aware explainer paragraph rendered beneath the Tunnel screen's
 * `<PageHeader>`. The copy swaps between two branches:
 *
 *   - "open" — the tunnel is (or is becoming) reachable; the public host is
 *     emphasized in the copy.
 *   - "closed" — the server has no tunnel (`off`).
 *
 * The variant is keyed onto the `<p>` so React remounts the paragraph
 * across copy swaps; a CSS keyframe on `.explainer` plays on mount,
 * giving the new copy a brief fade-up rather than an instant text
 * replacement.
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
