import type { JSX } from 'react'

import { sectionUrl } from 'branding-core'

import { AppIcon } from './app-icon.tsx'
import styles from './brand-bar.module.css'

/**
 * Slim, non-sticky brand bar for SMART-launched apps and the Tauri desktop
 * shell. The whole bar is a single link back to the marketing site.
 */
function BrandBar(): JSX.Element {
  return (
    <a className={styles['brand-bar']} href={sectionUrl('marketing')} aria-label="Wildflower home">
      <AppIcon size={24} />
      <span className={styles['brand-bar__wordmark']}>Wildflower</span>
    </a>
  )
}

export { BrandBar }
