import type { ElementType, JSX, ReactNode } from 'react'

import {
  HEADER_NAV_LINKS,
  anchorHref,
  sectionUrl,
  type NavContext,
  type NavLink,
} from 'branding-core'

import { AppIcon } from './app-icon.tsx'
import styles from './site-header.module.css'

/**
 * The element or component the brand lockup is wrapped in. Constrained to
 * what `SiteHeader` actually passes, so a caller can't hand over a component
 * that ignores the class or the children.
 */
type TitleComponent = ElementType<{
  readonly className?: string
  readonly children?: ReactNode
}>

function navLinkHref(link: NavLink, nav: NavContext): string {
  return link.kind === 'anchor' ? anchorHref(nav, link.anchor) : link.href
}

/**
 * Static top bar: brand on the left, in-page nav on the right, separated
 * from the page by a single hairline. It matches the marketing homepage's
 * header treatment — no sticky positioning, no translucent backdrop, no CTA
 * pill — so the app surfaces and the homepage read as one site. Both rows
 * wrap rather than collapse on phones.
 *
 * `--header-height` is still derived from this bar (padding + the 34px brand
 * mark + the hairline); it remains available for `scroll-margin-top` on
 * anchor targets even though a static header no longer covers them.
 *
 * @param nav - Determines whether links resolve as fragment-only (on the
 *   marketing site) or absolute (from an app).
 * @param titleAs - Element or component wrapping the brand lockup. Defaults
 *   to `'div'`, which is what an app wants: the app's own page heading is the
 *   `h1`. A surface whose brand *is* the page heading — the marketing
 *   homepage — passes `'h1'` instead. Only the wrapper changes; the styling
 *   and the link inside it are identical either way.
 */
function SiteHeader({
  nav,
  titleAs: Title = 'div',
}: {
  readonly nav: NavContext
  readonly titleAs?: TitleComponent
}): JSX.Element {
  const brandHref = nav.marketingBase === '' ? '#top' : sectionUrl('marketing')

  return (
    <header className={styles['site-header']} id="top">
      <div className={styles['site-header__inner']}>
        <Title className={styles['site-header__title']}>
          <a
            className={styles['site-header__brand']}
            href={brandHref}
            aria-label="Wildflower, home"
          >
            <AppIcon size={34} />
            <span className={styles['site-header__wordmark']}>Wildflower</span>
          </a>
        </Title>
        <nav className={styles['site-header__nav']} aria-label="Primary">
          {HEADER_NAV_LINKS.map((link) => (
            <a
              key={link.label}
              className={styles['site-header__link']}
              href={navLinkHref(link, nav)}
            >
              {link.label}
            </a>
          ))}
        </nav>
      </div>
    </header>
  )
}

export { SiteHeader }
export type { TitleComponent }
