/** The published site's domain: the marketing site's host, and the parent of every app's. */
const SITE_HOST = 'wildflowerhealth.io'

/** The production origin of the marketing site. */
const SITE_ORIGIN = `https://${SITE_HOST}`

/**
 * Each hosted app's slug: the subdomain of `wildflowerhealth.io` its own origin
 * is (`https://<slug>.wildflowerhealth.io/`), and, with `-web` added, the
 * `wildflowerhealthio/<slug>-web` repository whose `gh-pages` branch publishes
 * it, with its PR previews under `pr-<n>/`. `scripts/ci/pages-sites.ts` names
 * each app's site from these.
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
  // The WatchLifts watchapp's settings page: not a SMART app, so it has no app
  // description.
  watchLifts: 'watch-lifts',
  // The hosted launcher (`apps/launcher/launcher-web`), cross-origin to the API.
  launcher: 'launcher',
  // Wildflower Authorization (`apps/authorization/authorization-web`), where
  // the Owner manages what a server has authorized: every Wildflower server's
  // SMART `management_endpoint`, so its origin is a published contract.
  authorization: 'authorization',
  // The HALO App Catalog (`apps/app-catalog/app-catalog-web`): `/apps` is the
  // catalog itself, so its origin is a published contract.
  appCatalog: 'app-catalog',
} as const

/** Identifies one hosted app: a key of {@link APP_SLUGS}. */
type HostedAppId = keyof typeof APP_SLUGS

/** Identifies one section of the site: the marketing site or a hosted app. */
type SectionId = 'marketing' | HostedAppId

/**
 * Absolute, slash-terminated URL of a section on the published site. Links
 * from one section to another always use it, so a PR preview of one app links
 * the other apps' production builds.
 *
 * @param id - The section to resolve.
 * @returns `https://wildflowerhealth.io/` for marketing,
 *   `https://<slug>.wildflowerhealth.io/` for a hosted app.
 */
function sectionUrl(id: SectionId): string {
  if (id === 'marketing') return `${SITE_ORIGIN}/`
  return `https://${APP_SLUGS[id]}.${SITE_HOST}/`
}

/**
 * The marketing site's policy pages, by the directory each is served from
 * under {@link SITE_ORIGIN}. These must match the HTML entries of
 * `apps/wildflower-site/marketing-site-web` (`vite.config.ts`) and the
 * marketing site's `requiredFiles` in `scripts/ci/pages-sites.ts`.
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

export { APP_SLUGS, POLICY_IDS, POLICY_LABELS, POLICY_PATHS, SITE_ORIGIN, policyUrl, sectionUrl }
export type { HostedAppId, PolicyId, SectionId }
