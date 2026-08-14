import type { ComponentType, JSX } from 'react'

import { useHref } from '../hooks/use-href.ts'
import { AppIcon } from './app-icon.tsx'
import styles from './footer.module.css'

type FooterLink = {
  readonly label: string
  readonly href: string
  // A component (not a bare element) so it's rendered as its own fiber below —
  // it uses hooks (`useHref`), which must run inside their own component, not
  // be invoked as a plain function in the parent's render.
  readonly extra?: ComponentType
}

const PRODUCT_LINKS: readonly FooterLink[] = [
  { label: 'The apps', href: '#how' },
  { label: 'Privacy', href: '#privacy' },
  { label: 'Request invite', href: '#invite' },
]

const AboutTheCompany = (): JSX.Element => {
  const href = useHref()
  if (!href.includes('#about-the-company')) return <></>

  return (
    <>
      <br />
      <div className={styles['site-footer__blurb']} style={{ maxWidth: '200px' }}>
        There is no company! It's just me, Ruth Marks. I've been writing health tech software for 7
        years, and this is what I've been indirectly dreaming about since the beginning.
      </div>
    </>
  )
}

// Placeholder destinations — wire to real routes when they exist.
const COMPANY_LINKS: readonly FooterLink[] = [
  {
    label: 'About',
    href: '#about-the-company',
    extra: AboutTheCompany,
  },
  { label: 'Contact', href: 'mailto:ruthmarks151@gmail.com' },
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
        <div key={link.label}>
          <a className={styles['site-footer__link']} href={link.href}>
            {link.label}
          </a>
          {link.extra ? <link.extra /> : null}
        </div>
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
            A personal health record that runs on your phone, and a collection of apps that read
            from it — so your health record is finally{' '}
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
          <span>Made with love &mdash; in beautiful Toronto</span>
        </div>
      </div>
    </footer>
  )
}

export { Footer }
