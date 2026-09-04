import type { JSX } from 'react'

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
 * the four apps on the right. The `<h1>` here is the page's only `h1` by
 * design (SEO + a11y), even though the hero's manifesto title ("Patients
 * deserve health data freedom") is visually larger — do not demote it or
 * add a hidden `h1`.
 */
function SiteHeader(): JSX.Element {
  return (
    <header className={styles['site-header']}>
      <div className={`${layout['column']} ${styles['site-header__inner']}`}>
        <h1 className={styles['site-header__title']}>
          <a className={styles['site-header__brand']} href="#top">
            <AppIcon size={34} />
            Wildflower Health Project
          </a>
        </h1>
        <nav className={styles['site-header__nav']} aria-label="Apps">
          {NAV_LINKS.map((link) => (
            <a key={SECTION_PATHS[link.section]} href={sectionRootPath(link.section)}>
              {link.label}
            </a>
          ))}
        </nav>
      </div>
    </header>
  )
}

export { SiteHeader }
