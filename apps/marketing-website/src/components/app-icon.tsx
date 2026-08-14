import type { JSX } from 'react'

import styles from './app-icon.module.css'

/*
 * Resolved against Vite's base URL so the icon loads whether the site is
 * served from the domain root or a GitHub Pages project sub-path. The icon
 * is a `public/` asset, so it isn't import-hashed — `BASE_URL` (always
 * trailing-slashed) is the supported way to reference it.
 */
const ICON_SRC = `${import.meta.env.BASE_URL}app-icon.png`

/**
 * The Wildflower app icon. Decorative everywhere it appears (it always sits
 * beside the "Wildflower" wordmark or a heading), so it carries an empty
 * `alt`. `size` sets the rendered box; the design system's `--radius-2`
 * rounds it.
 */
function AppIcon({ size }: { readonly size: number }): JSX.Element {
  return <img className={styles['app-icon']} src={ICON_SRC} alt="" width={size} height={size} />
}

export { AppIcon }
