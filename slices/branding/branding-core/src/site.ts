/** The production origin for all Wildflower Health surfaces. */
const SITE_ORIGIN = 'https://wildflowerhealth.io'

/**
 * Deploy-contract paths for each site section. These must match the
 * `destPath` values in `apps/github-pages/src/assembly.ts` — a mismatch
 * breaks cross-section links on the assembled GitHub Pages site.
 */
const SECTION_PATHS = {
  marketing: '',
  medications: 'medications-app',
  importer: 'importer-app',
  webTrace: 'web-trace-app',
  serverDocs: 'wildflower-server-docs',
  ohifViewer: 'ohif-viewer',
  fhirSyncPebble: 'fhir-sync-pebble',
  healthViewer: 'health-viewer-app',
  syntheticData: 'synthetic-data-app',
  lifting: 'lifting',
  // The WatchLifts watchapp's settings page: not a SMART app, so it has no nav
  // link and no app description.
  watchLifts: 'watch-lifts',
  // The hosted launcher (`apps/launcher/launcher-web`), published cross-origin
  // to the API, under its folder's name.
  launcher: 'launcher',
} as const

/** Identifies one section of the assembled site. */
type SectionId = keyof typeof SECTION_PATHS

/**
 * Absolute URL for a site section.
 *
 * @param id - The section to resolve.
 * @returns `https://wildflowerhealth.io/` for marketing,
 *   `https://wildflowerhealth.io/<path>` for all others.
 */
function sectionUrl(id: SectionId): string {
  const path = SECTION_PATHS[id]
  return path === '' ? `${SITE_ORIGIN}/` : `${SITE_ORIGIN}/${path}`
}

/**
 * Root-relative path for a site section, suitable for same-origin
 * navigation or `<base>` resolution.
 *
 * @param id - The section to resolve.
 * @returns `'/'` for marketing, `'/<path>'` for all others.
 */
function sectionRootPath(id: SectionId): string {
  const path = SECTION_PATHS[id]
  return path === '' ? '/' : `/${path}`
}

/**
 * The root of the assembled site a section's copy is published under, as the
 * base its sibling sections resolve against.
 *
 * @param section - The section `sectionBaseUrl` serves; never `marketing`, which
 *   is the root itself.
 * @param sectionBaseUrl - The absolute URL of the directory the section's page
 *   is served from, e.g. the launcher's origin plus its router basepath.
 * @returns `sectionBaseUrl` with the section's own path taken off, slash-terminated,
 *   when it ends in that path — `https://wildflowerhealth.io/` for the published
 *   site, `https://wildflowerhealthio.github.io/staging/pr-7/` for a PR preview —
 *   and `https://wildflowerhealth.io/` for any other URL.
 *
 * @remarks
 * A PR preview publishes every section under its own `/staging/pr-<n>/`, so a
 * link from one preview section reaches the same preview's build of another. A
 * copy served anywhere else (a dev server at its origin root) is not part of an
 * assembled site, so its links go to the canonical one, as `fromApp`'s do.
 *
 * @example
 * ```ts
 * siteRootFor('launcher', 'https://wildflowerhealthio.github.io/staging/pr-7/launcher/')
 * // → 'https://wildflowerhealthio.github.io/staging/pr-7/'
 * siteRootFor('launcher', 'http://localhost:5173/') // → 'https://wildflowerhealth.io/'
 * ```
 */
function siteRootFor(section: Exclude<SectionId, 'marketing'>, sectionBaseUrl: string): string {
  const sectionBase = new URL(sectionBaseUrl)
  const directory = sectionBase.pathname.replace(/\/+$/, '')
  const sectionSuffix = `/${SECTION_PATHS[section]}`
  return directory.endsWith(sectionSuffix)
    ? `${sectionBase.origin}${directory.slice(0, -sectionSuffix.length)}/`
    : `${SITE_ORIGIN}/`
}

export { SECTION_PATHS, SITE_ORIGIN, sectionRootPath, sectionUrl, siteRootFor }
export type { SectionId }
