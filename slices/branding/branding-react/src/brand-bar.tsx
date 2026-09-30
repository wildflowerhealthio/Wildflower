import type { JSX, ReactNode } from 'react'

import { sectionUrl } from 'branding-core'

import { AppIcon } from './app-icon.tsx'
import styles from './brand-bar.module.css'

/**
 * Slim, non-sticky brand bar for SMART-launched apps and the Tauri desktop
 * shell. The bar is a link back to the marketing site, save for an optional
 * control at its right end.
 *
 * @param trailing - Rendered at the bar's right end, outside the link: a small
 *   control of the app's own, such as the telemetry status
 */
function BrandBar({ trailing }: { readonly trailing?: ReactNode }): JSX.Element {
  return (
    <header className={styles['brand-bar']}>
      <a
        className={styles['brand-bar__home']}
        href={sectionUrl('marketing')}
        aria-label="Wildflower, home"
      >
        <AppIcon size={24} />
        <span className={styles['brand-bar__wordmark']}>Wildflower</span>
      </a>
      {trailing === undefined ? null : (
        <div className={styles['brand-bar__trailing']}>{trailing}</div>
      )}
    </header>
  )
}

export { BrandBar }
