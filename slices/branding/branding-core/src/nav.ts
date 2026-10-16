import { sectionUrl, sectionUrlIn, siteRootFor, type SectionId } from './site.ts'

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
 * Tells the href resolvers where the marketing page and the apps live relative
 * to the current surface.
 *
 * @remarks
 * `marketingBase` is the empty string when the component is rendered on
 * the marketing site itself (anchor hrefs become fragment-only, e.g. `#built`),
 * and the full marketing URL when rendered from an app (anchor hrefs become
 * absolute, e.g. `https://wildflowerhealth.io/#built`). `siteRoot` is the root
 * of the copy of the site section links go into (`branding-core`'s
 * `siteRootFor`): the published site, where each app has its own origin, or a
 * PR preview, where every app sits under the preview's path.
 */
type NavContext = { readonly marketingBase: string; readonly siteRoot: string }

/**
 * Use on the marketing site: anchors resolve to fragment-only hrefs, and
 * section links into the copy of the site the page belongs to.
 *
 * @param pageUrl - The marketing page's URL, e.g. `document.baseURI`.
 */
const onMarketingSiteAt = (pageUrl: string): NavContext => ({
  marketingBase: '',
  siteRoot: siteRootFor('marketing', new URL('./', pageUrl).href),
})

/** Use from any non-marketing app: anchors and sections resolve to the published site. */
const fromApp: NavContext = {
  marketingBase: sectionUrl('marketing'),
  siteRoot: sectionUrl('marketing'),
}

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
 * docs). Resolved by {@link navHref} to the section's URL in the context's
 * copy of the site.
 */
type SectionNavLink = {
  readonly kind: 'section'
  readonly label: string
  readonly section: SectionId
}

/** A navigation link: an anchor reference, a fixed URL, or a site section. */
type NavLink = AnchorNavLink | AbsoluteNavLink | SectionNavLink

/**
 * Resolves a section link to a full href in the context's copy of the site:
 * the app's own origin on the published site, and the preview's build of it
 * from a PR preview's marketing page (so a reviewer clicking through stays in
 * the preview).
 *
 * @param ctx - Where the caller is rendered relative to the published site.
 * @param section - The target section.
 */
function sectionHref(ctx: NavContext, section: SectionId): string {
  return sectionUrlIn(section, ctx.siteRoot)
}

/** Resolves any {@link NavLink} to an href for the given context. */
function navHref(link: NavLink, ctx: NavContext): string {
  if (link.kind === 'anchor') return anchorHref(ctx, link.anchor)
  if (link.kind === 'section') return sectionHref(ctx, link.section)
  return link.href
}

/**
 * Primary nav links rendered in every site header — the marketing homepage
 * and each app share one bar with direct links into the six apps. The
 * hrefs resolve per context; see {@link navHref}.
 */
const HEADER_NAV_LINKS: readonly NavLink[] = [
  { kind: 'section', label: 'Medications', section: 'medications' },
  { kind: 'section', label: 'Plots', section: 'plots' },
  { kind: 'section', label: 'Strength', section: 'strength' },
  { kind: 'section', label: 'Importer', section: 'importer' },
  { kind: 'section', label: 'Server docs', section: 'serverDocs' },
  { kind: 'section', label: 'Imaging', section: 'ohifViewer' },
]

export {
  HEADER_NAV_LINKS,
  MARKETING_ANCHORS,
  anchorHref,
  fromApp,
  navHref,
  onMarketingSiteAt,
  sectionHref,
}
export type { AbsoluteNavLink, AnchorNavLink, MarketingAnchor, NavContext, NavLink, SectionNavLink }
