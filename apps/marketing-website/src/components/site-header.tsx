import { useEffect, useRef, useState, type JSX } from 'react'

import { SECTION_PATHS, sectionRootPath, type SectionId } from 'branding-core'
import { AppIcon } from 'branding-react'

import layout from './layout.module.css'
import styles from './site-header.module.css'

/** The four app links in the header, in design order. */
const NAV_LINKS: readonly { readonly label: string; readonly section: SectionId }[] = [
  { label: 'Medications', section: 'medications' },
  { label: 'Importer', section: 'importer' },
  { label: 'Web traces', section: 'webTrace' },
  { label: 'Server docs', section: 'serverDocs' },
]

/**
 * Static (not sticky) top bar: the site title on the left, direct entry to
 * the four apps on the right. The wordmark is a plain link, not a heading —
 * the page's only `h1` is the hero's manifesto title ("Patients deserve
 * health data freedom").
 *
 * At ≥840px the four app links sit inline. Below that they collapse behind a
 * hamburger toggle into a right-aligned dropdown panel (full-width below
 * 640px). The dropdown closes on selection, outside pointer-down, or Escape.
 */
function SiteHeader(): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const navRef = useRef<HTMLElement>(null)

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
    <header className={styles['site-header']}>
      <div className={`${layout['column']} ${styles['site-header__inner']}`}>
        <p className={styles['site-header__title']}>
          <a className={styles['site-header__brand']} href="#top">
            <AppIcon size={34} />
            Wildflower Health Project
          </a>
        </p>
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
              {NAV_LINKS.map((link) => (
                <li key={SECTION_PATHS[link.section]}>
                  <a
                    href={sectionRootPath(link.section)}
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
