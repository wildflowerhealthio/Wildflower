import type { JSX } from 'react'

import { AppIcon } from './app-icon.tsx'
import styles from './header.module.css'

/**
 * Sticky top bar: brand on the left, in-page nav on the right. The two
 * text links collapse on phones (the "Request invite" pill always stays).
 * Its height is the source of `--header-height`, which the Convergence
 * sticky selector and the anchor scroll offsets both depend on.
 */
function Header(): JSX.Element {
  return (
    <header className={styles['site-header']} id="top">
      <div className={styles['site-header__inner']}>
        <a className={styles['site-header__brand']} href="#top" aria-label="Wildflower, home">
          <AppIcon size={34} />
          <span className={styles['site-header__wordmark']}>Wildflower</span>
        </a>
        <nav className={styles['site-header__nav']} aria-label="Primary">
          <a
            className={`${styles['site-header__link']} ${styles['site-header__link--text']}`}
            href="#how"
          >
            How it works
          </a>
          <a
            className={`${styles['site-header__link']} ${styles['site-header__link--text']}`}
            href="#privacy"
          >
            Privacy
          </a>
          <a className={`button-1 outline ${styles['site-header__cta']}`} href="#invite">
            Request invite
          </a>
        </nav>
      </div>
    </header>
  )
}

export { Header }
