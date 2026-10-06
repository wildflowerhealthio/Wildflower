import type { JSX } from 'react'

import styles from './TunnelExplainer.module.css'

/**
 * Explainer paragraph rendered beneath the Tunnel screen's `<PageHeader>`.
 */
const TunnelExplainer = (): JSX.Element => (
  <p className={styles['explainer']}>
    Apps and people you&apos;ve authorized can reach your device through its tunnel.
    <br />
    Apps and devices can only access your personal health record with your explicit permission
    &mdash; granted through the Wildflower app.
  </p>
)

export { TunnelExplainer }
