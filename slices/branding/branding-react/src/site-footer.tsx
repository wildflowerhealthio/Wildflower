import type { JSX } from 'react'

import {
  FOOTER_COMPANY_LINKS,
  FOOTER_PRODUCT_LINKS,
  anchorHref,
  type NavContext,
  type NavLink,
} from 'branding-core'

import { AppIcon } from './app-icon.tsx'
import styles from './site-footer.module.css'

type FooterLink = {
  readonly label: string
  readonly href: string
}

function resolveLink(link: NavLink, nav: NavContext): FooterLink {
  return {
    label: link.label,
    href: link.kind === 'anchor' ? anchorHref(nav, link.anchor) : link.href,
  }
}

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
        </div>
      ))}
    </div>
  )
}

/**
 * Site footer: brand blurb, the Product and Company link columns, and
 * the bottom bar. Links resolve against the given `NavContext`.
 *
 * @param nav - Determines whether anchor links resolve as fragment-only
 *   (marketing site) or absolute (from an app).
 */
function SiteFooter({ nav }: { readonly nav: NavContext }): JSX.Element {
  const productLinks = FOOTER_PRODUCT_LINKS.map((link) => resolveLink(link, nav))
  const companyLinks = FOOTER_COMPANY_LINKS.map((link) => resolveLink(link, nav))

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
          <FooterColumn label="Product" links={productLinks} />
          <FooterColumn label="Company" links={companyLinks} />
        </div>
      </div>
      <div className={styles['site-footer__bottom-wrap']}>
        <div className={styles['site-footer__bottom']}>
          <span>&copy; 2026 Wildflower Health</span>
          <span>Made with love &mdash; in beautiful Toronto</span>
        </div>
      </div>
    </footer>
  )
}

export { SiteFooter }
