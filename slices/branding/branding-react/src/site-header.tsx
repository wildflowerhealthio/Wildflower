import type { JSX } from 'react'

import {
  HEADER_NAV_LINKS,
  anchorHref,
  sectionUrl,
  type NavContext,
  type NavLink,
} from 'branding-core'

import { AppIcon } from './app-icon.tsx'
import styles from './site-header.module.css'

function navLinkHref(link: NavLink, nav: NavContext): string {
  return link.kind === 'anchor' ? anchorHref(nav, link.anchor) : link.href
}

/**
 * Sticky top bar: brand on the left, in-page nav on the right. The two
 * text links collapse on phones (the "Request invite" pill always stays).
 * Its height is the source of `--header-height`, which consumers use for
 * `scroll-margin-top` on anchor targets.
 *
 * @param nav - Determines whether links resolve as fragment-only (on the
 *   marketing site) or absolute (from an app).
 */
function SiteHeader({ nav }: { readonly nav: NavContext }): JSX.Element {
  const brandHref = nav.marketingBase === '' ? '#top' : sectionUrl('marketing')

  return (
    <header className={styles['site-header']} id="top">
      <div className={styles['site-header__inner']}>
        <a className={styles['site-header__brand']} href={brandHref} aria-label="Wildflower, home">
          <AppIcon size={34} />
          <span className={styles['site-header__wordmark']}>Wildflower</span>
        </a>
        <nav className={styles['site-header__nav']} aria-label="Primary">
          {HEADER_NAV_LINKS.map((link) => {
            const href = navLinkHref(link, nav)
            if (link.kind === 'anchor' && link.cta) {
              return (
                <a
                  key={link.label}
                  className={`button button-1 outline ${styles['site-header__cta']}`}
                  href={href}
                >
                  {link.label}
                </a>
              )
            }
            return (
              <a
                key={link.label}
                className={`${styles['site-header__link']} ${styles['site-header__link--text']}`}
                href={href}
              >
                {link.label}
              </a>
            )
          })}
        </nav>
      </div>
    </header>
  )
}

export { SiteHeader }
