import type { ComponentType, JSX } from 'react'

import {
  FOOTER_COMPANY_LINKS,
  FOOTER_PRODUCT_LINKS,
  anchorHref,
  type NavContext,
  type NavLink,
} from 'branding-core'

import { AppIcon } from './app-icon.tsx'
import { useHref } from './use-href.ts'
import styles from './site-footer.module.css'

type FooterLink = {
  readonly label: string
  readonly href: string
  readonly extra?: ComponentType
}

function resolveLinks(links: readonly NavLink[], nav: NavContext): readonly FooterLink[] {
  return links.map((link) => ({
    label: link.label,
    href: link.kind === 'anchor' ? anchorHref(nav, link.anchor) : link.href,
  }))
}

/** Hash-gated blurb that appears beside the "About" footer link. */
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

/**
 * Site footer: brand blurb, the Product and Company link columns, and
 * the bottom bar. Links resolve against the given `NavContext`.
 *
 * @param nav - Determines whether anchor links resolve as fragment-only
 *   (marketing site) or absolute (from an app).
 */
function SiteFooter({ nav }: { readonly nav: NavContext }): JSX.Element {
  const productLinks = resolveLinks(FOOTER_PRODUCT_LINKS, nav)
  const companyBase = resolveLinks(FOOTER_COMPANY_LINKS, nav)
  const companyLinks: readonly FooterLink[] = companyBase.map((link) =>
    link.label === 'About' ? { ...link, extra: AboutTheCompany } : link
  )

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

export { AboutTheCompany, SiteFooter }
