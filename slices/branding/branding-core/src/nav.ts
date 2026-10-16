import { sectionUrl, type SectionId } from './site.ts'

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

/**
 * A navigation link that points to a site section (an app or the server
 * docs). Resolved by {@link navHref} to the section's published URL
 * (`sectionUrl`), from the marketing site and from every app alike.
 */
type SectionNavLink = {
  readonly kind: 'section'
  readonly label: string
  readonly section: SectionId
}

/** A navigation link: an anchor reference, a fixed URL, or a site section. */
type NavLink = AnchorNavLink | AbsoluteNavLink | SectionNavLink

/** Resolves any {@link NavLink} to an href for the given context. */
function navHref(link: NavLink, ctx: NavContext): string {
  if (link.kind === 'anchor') return anchorHref(ctx, link.anchor)
  if (link.kind === 'section') return sectionUrl(link.section)
  return link.href
}

/**
 * Primary nav links rendered in every site header — the marketing homepage
 * and each app share one bar with direct links into the six apps, each at its
 * published origin; see {@link navHref}.
 */
const HEADER_NAV_LINKS: readonly NavLink[] = [
  { kind: 'section', label: 'Medications', section: 'medications' },
  { kind: 'section', label: 'Plots', section: 'plots' },
  { kind: 'section', label: 'Strength', section: 'strength' },
  { kind: 'section', label: 'Importer', section: 'importer' },
  { kind: 'section', label: 'Server docs', section: 'serverDocs' },
  { kind: 'section', label: 'Imaging', section: 'ohifViewer' },
]

export { HEADER_NAV_LINKS, MARKETING_ANCHORS, anchorHref, fromApp, navHref, onMarketingSite }
export type { AbsoluteNavLink, AnchorNavLink, MarketingAnchor, NavContext, NavLink, SectionNavLink }
