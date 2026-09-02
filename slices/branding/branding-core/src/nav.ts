import { sectionUrl } from './site.ts'

/**
 * Hash anchors on the marketing page. Most map to `<section id="…">`
 * elements; `about-the-company` gates a hash-conditional UI element
 * in the footer rather than a page section.
 */
const MARKETING_ANCHORS = ['top', 'how', 'privacy', 'invite', 'about-the-company'] as const

/** A hash anchor defined on the marketing landing page. */
type MarketingAnchor = (typeof MARKETING_ANCHORS)[number]

/**
 * Tells the anchor-href resolver where the marketing page lives relative
 * to the current surface.
 *
 * @remarks
 * `marketingBase` is the empty string when the component is rendered on
 * the marketing site itself (hrefs become fragment-only, e.g. `#how`),
 * and the full marketing URL when rendered from an app (hrefs become
 * absolute, e.g. `https://wildflowerhealth.io/#how`).
 */
type NavContext = { readonly marketingBase: string }

/** Use on the marketing site: anchors resolve to fragment-only hrefs. */
const onMarketingSite: NavContext = { marketingBase: '' }

/** Use from any non-marketing app: anchors resolve to absolute URLs. */
const fromApp: NavContext = { marketingBase: sectionUrl('marketing') }

/**
 * Resolves a marketing-page anchor to a full href, respecting the
 * current navigation context.
 *
 * @param ctx - Where the marketing page lives relative to the caller.
 * @param anchor - The target anchor on the marketing page.
 */
function anchorHref(ctx: NavContext, anchor: MarketingAnchor): string {
  return `${ctx.marketingBase}#${anchor}`
}

/** A navigation link that points to a marketing-page anchor. */
type AnchorNavLink = {
  readonly kind: 'anchor'
  readonly label: string
  readonly anchor: MarketingAnchor
  readonly cta?: boolean
}

/** A navigation link with a fixed absolute href (not anchor-relative). */
type AbsoluteNavLink = {
  readonly kind: 'absolute'
  readonly label: string
  readonly href: string
}

/** A navigation link: either an anchor reference or a fixed URL. */
type NavLink = AnchorNavLink | AbsoluteNavLink

/** Primary nav links rendered in the site header. */
const HEADER_NAV_LINKS: readonly NavLink[] = [
  { kind: 'anchor', label: 'The apps', anchor: 'how' },
  { kind: 'anchor', label: 'Privacy', anchor: 'privacy' },
  { kind: 'anchor', label: 'Request invite', anchor: 'invite', cta: true },
]

/** Product-column links rendered in the site footer. */
const FOOTER_PRODUCT_LINKS: readonly NavLink[] = [
  { kind: 'anchor', label: 'The apps', anchor: 'how' },
  { kind: 'anchor', label: 'Privacy', anchor: 'privacy' },
  { kind: 'anchor', label: 'Request invite', anchor: 'invite' },
  { kind: 'absolute', label: 'Server API docs', href: sectionUrl('serverDocs') },
]

/** Company-column links rendered in the site footer. */
const FOOTER_COMPANY_LINKS: readonly NavLink[] = [
  { kind: 'anchor', label: 'About', anchor: 'about-the-company' },
  { kind: 'absolute', label: 'Contact', href: 'mailto:ruthmarks151@gmail.com' },
]

export {
  FOOTER_COMPANY_LINKS,
  FOOTER_PRODUCT_LINKS,
  HEADER_NAV_LINKS,
  MARKETING_ANCHORS,
  anchorHref,
  fromApp,
  onMarketingSite,
}
export type { AbsoluteNavLink, AnchorNavLink, MarketingAnchor, NavContext, NavLink }
