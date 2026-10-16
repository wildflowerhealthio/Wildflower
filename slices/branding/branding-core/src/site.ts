/** The published site's domain: the marketing site's host, and the parent of every app's. */
const SITE_HOST = 'wildflowerhealth.io'

/** The production origin of the marketing site. */
const SITE_ORIGIN = `https://${SITE_HOST}`

/**
 * Each hosted app's slug: the subdomain of `wildflowerhealth.io` its own origin
 * is (`https://<slug>.wildflowerhealth.io/`), the directory a PR preview
 * assembles it into (`…/staging/pr-<n>/<slug>/`), and, with `-web` added, the
 * `wildflowerhealthio/<slug>-web` repository its published site is pushed to.
 * `apps/wildflower-site/wildflower-site-web/src/assembly.ts` lays the site out
 * from these, and `.github/workflows/deploy-github-pages.yml` mints its push
 * token for exactly these repositories.
 *
 * @remarks
 * Each app has an origin to itself so that no app, or an XSS in one, can read
 * another app's `localStorage`.
 */
const APP_SLUGS = {
  medications: 'medications',
  importer: 'importer',
  serverDocs: 'server-docs',
  ohifViewer: 'ohif-viewer',
  fhirSyncPebble: 'fhir-sync-pebble',
  plots: 'plots',
  syntheticData: 'synthetic-data',
  strength: 'strength',
  // The WatchLifts watchapp's settings page: not a SMART app, so it has no nav
  // link and no app description.
  watchLifts: 'watch-lifts',
  // The hosted launcher (`apps/launcher/launcher-web`), cross-origin to the API.
  launcher: 'launcher',
  // Wildflower Authorization (`apps/authorization/authorization-web`), where
  // the Owner manages what a server has authorized: every Wildflower server's
  // SMART `management_endpoint`, so its origin is a published contract.
  authorization: 'authorization',
} as const

/** Identifies one hosted app: a key of {@link APP_SLUGS}. */
type HostedAppId = keyof typeof APP_SLUGS

/** Identifies one section of the site: the marketing site or a hosted app. */
type SectionId = 'marketing' | HostedAppId

/** The site root {@link siteRootFor} answers for anything but a PR preview. */
const PUBLISHED_SITE_ROOT = `${SITE_ORIGIN}/`

/**
 * Absolute, slash-terminated URL of a section on the published site.
 *
 * @param id - The section to resolve.
 * @returns `https://wildflowerhealth.io/` for marketing,
 *   `https://<slug>.wildflowerhealth.io/` for a hosted app.
 */
function sectionUrl(id: SectionId): string {
  if (id === 'marketing') return PUBLISHED_SITE_ROOT
  return `https://${APP_SLUGS[id]}.${SITE_HOST}/`
}

/**
 * Absolute, slash-terminated URL of a section in one copy of the site.
 *
 * @param id - The section to resolve.
 * @param siteRoot - The copy's root, from {@link siteRootFor}.
 * @returns {@link sectionUrl} when `siteRoot` is the published site's, where
 *   each app has its own origin; otherwise the section's directory under
 *   `siteRoot`, where a PR preview assembles every app under one path.
 *
 * @example
 * ```ts
 * sectionUrlIn('plots', 'https://wildflowerhealth.io/') // → 'https://plots.wildflowerhealth.io/'
 * sectionUrlIn('plots', 'https://wildflowerhealthio.github.io/staging/pr-7/')
 * // → 'https://wildflowerhealthio.github.io/staging/pr-7/plots/'
 * ```
 */
function sectionUrlIn(id: SectionId, siteRoot: string): string {
  if (siteRoot === PUBLISHED_SITE_ROOT) return sectionUrl(id)
  return id === 'marketing' ? siteRoot : new URL(`${APP_SLUGS[id]}/`, siteRoot).href
}

/**
 * The root of the copy of the site a section's page is served from, as the
 * base its sibling sections resolve against ({@link sectionUrlIn}).
 *
 * @param section - The section `sectionBaseUrl` serves.
 * @param sectionBaseUrl - The absolute URL of the directory the section's page
 *   is served from, e.g. the launcher's origin plus its router basepath.
 * @returns For a hosted app, `sectionBaseUrl` with the app's slug taken off,
 *   slash-terminated, when it ends in that slug — a PR preview's
 *   `https://wildflowerhealthio.github.io/staging/pr-7/` — and
 *   `https://wildflowerhealth.io/` for any other URL. For marketing, which is
 *   the root of its copy, its own directory, unless that is on the published
 *   origin.
 *
 * @remarks
 * A PR preview publishes every section under its own `/staging/pr-<n>/`, so a
 * link from one preview section reaches the same preview's build of another.
 * A hosted app served anywhere else (its own origin, or a dev server at its
 * origin root) is not part of an assembled preview, so its links go to the
 * published site, as `fromApp`'s do.
 *
 * @example
 * ```ts
 * siteRootFor('launcher', 'https://wildflowerhealthio.github.io/staging/pr-7/launcher/')
 * // → 'https://wildflowerhealthio.github.io/staging/pr-7/'
 * siteRootFor('launcher', 'https://launcher.wildflowerhealth.io/') // → 'https://wildflowerhealth.io/'
 * siteRootFor('marketing', 'https://wildflowerhealthio.github.io/staging/pr-7/')
 * // → 'https://wildflowerhealthio.github.io/staging/pr-7/'
 * ```
 */
function siteRootFor(section: SectionId, sectionBaseUrl: string): string {
  const sectionBase = new URL(sectionBaseUrl)
  const directory = sectionBase.pathname.replace(/\/+$/, '')
  if (section === 'marketing') {
    return sectionBase.origin === SITE_ORIGIN
      ? PUBLISHED_SITE_ROOT
      : `${sectionBase.origin}${directory}/`
  }
  const sectionSuffix = `/${APP_SLUGS[section]}`
  return directory.endsWith(sectionSuffix)
    ? `${sectionBase.origin}${directory.slice(0, -sectionSuffix.length)}/`
    : PUBLISHED_SITE_ROOT
}

/**
 * The marketing site's policy pages, by the directory each is served from
 * under {@link SITE_ORIGIN}. These must match the HTML entries of
 * `apps/wildflower-site/marketing-site-web` (`vite.config.ts`) and the
 * `requiredFiles` of `apps/wildflower-site/wildflower-site-web/src/assembly.ts`.
 * Google Play and the App Store link to the privacy policy and the deletion
 * page for Wildflower Host, and Washington's My Health My Data Act wants the
 * consumer health data policy linked from the homepage, so their paths are a
 * published contract.
 */
const POLICY_PATHS = {
  privacyPolicy: 'privacy-policy',
  consumerHealthData: 'consumer-health-data',
  terms: 'terms',
  deletion: 'deletion',
} as const

/** Identifies one of the site's policy pages. */
type PolicyId = keyof typeof POLICY_PATHS

/** Every policy page, in the order the footer and the settings menus list them. */
const POLICY_IDS: readonly PolicyId[] = ['privacyPolicy', 'consumerHealthData', 'terms', 'deletion']

/** What each policy page is called where it is linked: the footer, the settings menus, the consent dialog. */
const POLICY_LABELS: Readonly<Record<PolicyId, string>> = {
  privacyPolicy: 'Privacy policy',
  consumerHealthData: 'Consumer health data',
  terms: 'Terms of use',
  deletion: 'Deleting your data',
}

/**
 * Absolute, slash-terminated URL of a policy page on the canonical site,
 * e.g. `https://wildflowerhealth.io/privacy-policy/`. Always the canonical
 * site, never a preview or a dev server: the stores link to these URLs, and
 * an app's settings menu links to the same page the stores do.
 */
function policyUrl(id: PolicyId): string {
  return `${SITE_ORIGIN}/${POLICY_PATHS[id]}/`
}

export {
  APP_SLUGS,
  POLICY_IDS,
  POLICY_LABELS,
  POLICY_PATHS,
  SITE_ORIGIN,
  policyUrl,
  sectionUrl,
  sectionUrlIn,
  siteRootFor,
}
export type { HostedAppId, PolicyId, SectionId }
