import { SECTION_PATHS, sectionUrl, type SectionId } from './site.ts'

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
 * docs). Resolved by {@link navHref} to a root-relative path on the
 * marketing site and an absolute URL from an app.
 */
type SectionNavLink = {
  readonly kind: 'section'
  readonly label: string
  readonly section: SectionId
}

/** A navigation link: an anchor reference, a fixed URL, or a site section. */
type NavLink = AnchorNavLink | AbsoluteNavLink | SectionNavLink

/**
 * Resolves a section link to a full href, respecting the current
 * navigation context. Current-URL-relative on the marketing site (so a
 * preview deploy under `/staging/pr-N/` routes into its sibling preview
 * builds rather than the canonical origin), and absolute from an app (so
 * a self-hosted bundle still points at the canonical site).
 *
 * @remarks
 * The marketing-site case is a plain relative reference — the browser
 * resolves it against the document base URL, which is the page's own URL
 * (or a `<base>` if the page sets one). That is what lets one link work
 * from `wildflowerhealth.io/` and from `.../staging/pr-N/` without any
 * build-time base injection.
 *
 * @param ctx - Where the caller is rendered relative to the canonical site.
 * @param section - The target section.
 */
function sectionHref(ctx: NavContext, section: SectionId): string {
  if (ctx.marketingBase !== '') return sectionUrl(section)
  const path = SECTION_PATHS[section]
  return path === '' ? './' : `./${path}`
}

/** Resolves any {@link NavLink} to an href for the given context. */
function navHref(link: NavLink, ctx: NavContext): string {
  if (link.kind === 'anchor') return anchorHref(ctx, link.anchor)
  if (link.kind === 'section') return sectionHref(ctx, link.section)
  return link.href
}

/**
 * Primary nav links rendered in every site header — the marketing homepage
 * and each app share one bar with direct links into the four apps. The
 * hrefs resolve per context (root-relative on marketing, absolute from an
 * app); see {@link navHref}.
 */
const HEADER_NAV_LINKS: readonly NavLink[] = [
  { kind: 'section', label: 'Medications', section: 'medications' },
  { kind: 'section', label: 'Importer', section: 'importer' },
  { kind: 'section', label: 'Web traces', section: 'webTrace' },
  { kind: 'section', label: 'Server docs', section: 'serverDocs' },
]

export {
  HEADER_NAV_LINKS,
  MARKETING_ANCHORS,
  anchorHref,
  fromApp,
  navHref,
  onMarketingSite,
  sectionHref,
}
export type { AbsoluteNavLink, AnchorNavLink, MarketingAnchor, NavContext, NavLink, SectionNavLink }
