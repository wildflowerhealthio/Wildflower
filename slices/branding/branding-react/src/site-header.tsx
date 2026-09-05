import { useEffect, useRef, useState, type ElementType, type JSX, type ReactNode } from 'react'

import { HEADER_NAV_LINKS, navHref, sectionUrl, type NavContext } from 'branding-core'

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

/**
 * Static top bar shared by the marketing homepage and every app: the brand
 * lockup on the left, direct links into the four apps on the right, one
 * hairline against the page. No sticky positioning, no translucent backdrop,
 * no CTA pill — the app surfaces and the homepage read as one site.
 *
 * The link *set* is the same everywhere; only href resolution follows the
 * `nav` context (root-relative on marketing, absolute from an app — see
 * `navHref`). At ≥840px the four links sit inline; below that they collapse
 * behind a hamburger toggle into a right-aligned dropdown (full-width below
 * 640px) that closes on selection, outside pointer-down, or Escape.
 *
 * `--header-height` is still derived from this bar (padding + the 34px brand
 * mark + the hairline); it remains available for `scroll-margin-top` on
 * anchor targets even though a static header no longer covers them.
 *
 * @param nav - Determines whether links resolve as root-relative (on the
 *   marketing site) or absolute (from an app).
 * @param titleAs - Element or component wrapping the brand lockup. Defaults
 *   to `'div'`, which is what an app wants: the app's own page heading is the
 *   `h1`. A surface whose brand is *not* a heading — the marketing homepage,
 *   whose `h1` is the hero manifesto — also uses the default. Only the
 *   wrapper changes; the styling and the link inside it are identical.
 */
function SiteHeader({
  nav,
  titleAs: Title = 'div',
}: {
  readonly nav: NavContext
  readonly titleAs?: TitleComponent
}): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const navRef = useRef<HTMLElement>(null)

  const brandHref = nav.marketingBase === '' ? '#top' : sectionUrl('marketing')

  useEffect(() => {
    if (!menuOpen) return undefined
    const closeOnOutside = (event: PointerEvent): void => {
      const target = event.target
      if (target instanceof Node && navRef.current !== null && !navRef.current.contains(target)) {
        setMenuOpen(false)
      }
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [menuOpen])

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
            <span className={styles['site-header__wordmark']}>Wildflower Health Project</span>
          </a>
        </Title>
        <nav className={styles['site-header__nav']} aria-label="Apps" ref={navRef}>
          <button
            type="button"
            className={styles['site-header__toggle']}
            aria-controls="site-header-menu"
            aria-expanded={menuOpen}
            aria-label="Apps menu"
            onClick={() => {
              setMenuOpen((open) => !open)
            }}
          >
            <MenuIcon />
          </button>
          <div
            id="site-header-menu"
            className={styles['site-header__menu']}
            data-open={menuOpen ? 'true' : 'false'}
          >
            <p className={styles['site-header__menu-title']}>Apps</p>
            <ul className={styles['site-header__menu-list']}>
              {HEADER_NAV_LINKS.map((link) => (
                <li key={link.label}>
                  <a
                    className={styles['site-header__link']}
                    href={navHref(link, nav)}
                    onClick={() => {
                      setMenuOpen(false)
                    }}
                  >
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </nav>
      </div>
    </header>
  )
}

/** Three-bar hamburger glyph; decorative — the button carries the label. */
function MenuIcon(): JSX.Element {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 7h16M4 12h16M4 17h16"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  )
}

export { SiteHeader }
export type { TitleComponent }
