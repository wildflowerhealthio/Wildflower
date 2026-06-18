import type { JSX } from 'react'

import { AppIcon } from './app-icon.tsx'
import styles from './footer.module.css'

type FooterLink = {
  readonly label: string
  readonly href: string
}

const PRODUCT_LINKS: readonly FooterLink[] = [
  { label: 'How it works', href: '#how' },
  { label: 'Privacy', href: '#privacy' },
  { label: 'Request invite', href: '#invite' },
]

// Placeholder destinations — wire to real routes when they exist.
const COMPANY_LINKS: readonly FooterLink[] = [
  { label: 'About', href: '#' },
  { label: 'Standards & security', href: '#' },
  { label: 'Contact', href: '#' },
]

function FooterColumn({
  label,
  links,
}: {
  readonly label: string
  readonly links: readonly FooterLink[]
}): JSX.Element {
  return (
    <div className={styles['site-footer__col']}>
      <p className={styles['site-footer__col-label']}>{label}</p>
      {links.map((link) => (
        <a key={link.label} className={styles['site-footer__link']} href={link.href}>
          {link.label}
        </a>
      ))}
    </div>
  )
}

/** Site footer: brand blurb, the two link columns, and the bottom bar. */
function Footer(): JSX.Element {
  return (
    <footer className={styles['site-footer']}>
      <div className={styles['site-footer__top']}>
        <div className={styles['site-footer__brand-col']}>
          <div className={styles['site-footer__brand']}>
            <AppIcon size={30} />
            <span className={styles['site-footer__wordmark']}>Wildflower</span>
          </div>
          <p className={styles['site-footer__blurb']}>
            A personal health record that runs securely on your phone — built on the open standard
            behind modern health records — so your health record is finally{' '}
            <em className={styles['site-footer__em']}>yours.</em>
          </p>
        </div>
        <div className={styles['site-footer__cols']}>
          <FooterColumn label="Product" links={PRODUCT_LINKS} />
          <FooterColumn label="Company" links={COMPANY_LINKS} />
        </div>
      </div>
      <div className={styles['site-footer__bottom-wrap']}>
        <div className={styles['site-footer__bottom']}>
          <span>© 2026 Wildflower Health</span>
          <span>Built on modern data standards · FHIR</span>
        </div>
      </div>
    </footer>
  )
}

export { Footer }
