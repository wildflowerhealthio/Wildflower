import type { JSX } from 'react'

import styles from './site-footer.module.css'

/**
 * The footer, shared by the marketing homepage and each app's standalone
 * landing page: the "not a company" paragraph, the plain contact line, and a
 * mono stamp. No link columns, no social icons — the page ends the way it
 * speaks. `id="note"` is the anchor target the marketing homepage's "About"
 * references resolve to.
 */
function SiteFooter(): JSX.Element {
  const year = new Date().getFullYear()

  return (
    <footer className={styles['site-footer']} id="note">
      <div className={styles['site-footer__inner']}>
        <p className={styles['site-footer__body']}>
          The Wildflower Health Project is an open source series of connected experiments to try and
          show what an interoperable personal health record could look like.
          <br />
          <br />
          If you want to try it, are hiring, or just want to talk open health —{' '}
          <a href="mailto:ruthmarks151@gmail.com">ruthmarks151@gmail.com</a>
        </p>
        <p className={styles['site-footer__stamp']}>
          Wildflower Health Project &middot; Ruth Marks &middot; {year}
        </p>
      </div>
    </footer>
  )
}

export { SiteFooter }
