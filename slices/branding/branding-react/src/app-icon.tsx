import type { JSX } from 'react'

import iconSrc from './assets/app-icon.ts'
import styles from './app-icon.module.css'

/**
 * The Wildflower app icon. Decorative everywhere it appears (it always sits
 * beside the "Wildflower" wordmark or a heading), so it carries an empty
 * `alt`. `size` sets the rendered box; the design system's `--radius-2`
 * rounds it.
 */
function AppIcon({ size }: { readonly size: number }): JSX.Element {
  return <img className={styles['app-icon']} src={iconSrc} alt="" width={size} height={size} />
}

export { AppIcon }
