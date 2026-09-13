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

export { SECTION_PATHS, SITE_ORIGIN, sectionRootPath, sectionUrl }
export type { SectionId }
