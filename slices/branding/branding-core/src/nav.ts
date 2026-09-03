import { sectionUrl } from './site.ts'

/**
 * Hash anchors on the marketing homepage, in section order: the hero
 * (`top`), the patient-facing apps (`built`), the infrastructure (`try`),
 * the policy asks (`asks`), developer tooling (`developers`), and the
 * footer's "not a company" note (`note`).
 */
const MARKETING_ANCHORS = ['top', 'built', 'try', 'asks', 'developers', 'note'] as const

/** A hash anchor defined on the marketing landing page. */
type MarketingAnchor = (typeof MARKETING_ANCHORS)[number]

/**
 * Tells the anchor-href resolver where the marketing page lives relative
 * to the current surface.
 *
 * @remarks
 * `marketingBase` is the empty string when the component is rendered on
 * the marketing site itself (hrefs become fragment-only, e.g. `#built`),
 * and the full marketing URL when rendered from an app (hrefs become
 * absolute, e.g. `https://wildflowerhealth.io/#built`).
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

/**
 * Primary nav links rendered in the app site headers. (The marketing
 * homepage renders its own header — direct links into the four apps — so
 * these resolve from apps back to the homepage's sections. The homepage
 * redesign has no invite flow, hence no CTA link.)
 */
const HEADER_NAV_LINKS: readonly NavLink[] = [
  { kind: 'anchor', label: 'The apps', anchor: 'built' },
  { kind: 'anchor', label: 'For developers', anchor: 'developers' },
]

/** Product-column links rendered in the app site footers. */
const FOOTER_PRODUCT_LINKS: readonly NavLink[] = [
  { kind: 'anchor', label: 'The apps', anchor: 'built' },
  { kind: 'anchor', label: 'For developers', anchor: 'developers' },
  { kind: 'absolute', label: 'Server API docs', href: sectionUrl('serverDocs') },
]

/** Company-column links rendered in the app site footers. */
const FOOTER_COMPANY_LINKS: readonly NavLink[] = [
  { kind: 'anchor', label: 'About', anchor: 'note' },
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
