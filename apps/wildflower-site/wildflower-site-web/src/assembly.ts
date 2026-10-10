import { join, relative, sep } from 'node:path'

import { SECTION_PATHS } from '@wildflowerhealthio/branding-core'

/**
 * One already-built tree that gets copied into the assembled GitHub Pages
 * site. The build of each section is owned by its own package; this package
 * only places the outputs at their public URLs.
 */
interface SiteSection {
  /** Workspace package whose `build` script produces {@link sourceDir}. */
  readonly packageName: string
  /** Repo-root-relative directory holding that package's build output. */
  readonly sourceDir: string
  /**
   * Site-root-relative directory the output is copied to. The empty string
   * means the root of the published site.
   */
  readonly destPath: string
  /**
   * Files that MUST exist under {@link destPath} once the copy is done,
   * relative to it. Checked after assembly so a silently-empty upstream build
   * fails the deploy instead of publishing a broken site.
   */
  readonly requiredFiles: readonly string[]
}

/**
 * The published layout of https://wildflowerhealth.io.
 *
 * `docs/` (generated HTML documentation) joins this list in a later change.
 */
const siteSections: readonly SiteSection[] = [
  {
    packageName: '@wildflowerhealthio/marketing-site-web',
    sourceDir: 'apps/wildflower-site/marketing-site-web/dist',
    destPath: SECTION_PATHS.marketing,
    // `CNAME` (copied from the marketing site's `public/`) has to land at the
    // artifact root or GitHub Pages drops the custom-domain setting on deploy.
    // The policy pages are app-store requirements, so their entries are too.
    requiredFiles: [
      'index.html',
      'CNAME',
      'privacy-policy/index.html',
      'terms/index.html',
      'deletion/index.html',
    ],
  },
  {
    packageName: '@wildflowerhealthio/medications-web',
    sourceDir: 'apps/medications/medications-web/dist',
    destPath: SECTION_PATHS.medications,
    // One entry: the app root starts a SMART launch its URL carries, is the
    // OAuth redirect target, and serves the standalone connect menu on a bare
    // visit.
    requiredFiles: ['index.html'],
  },
  {
    packageName: '@wildflowerhealthio/importer-web',
    // The package lives in `apps/importer-web`; its published path is
    // `/${SECTION_PATHS.importer}`.
    sourceDir: 'apps/importer-web/dist',
    destPath: SECTION_PATHS.importer,
    // One entry: the app root starts a SMART launch its URL carries, is the
    // OAuth redirect target, and serves the standalone connect menu on a bare
    // visit.
    requiredFiles: ['index.html'],
  },
  {
    packageName: '@wildflowerhealthio/server-docs-web',
    sourceDir: 'apps/server-docs-web/dist',
    destPath: SECTION_PATHS.serverDocs,
    // A single-page console; the bundled assets hang off it.
    requiredFiles: ['index.html'],
  },
  {
    packageName: '@wildflowerhealthio/fhir-sync-pebble-web',
    // The package lives in `apps/fhir-sync-pebble/fhir-sync-pebble-web`; its
    // published path is `/${SECTION_PATHS.fhirSyncPebble}`.
    sourceDir: 'apps/fhir-sync-pebble/fhir-sync-pebble-web/dist',
    destPath: SECTION_PATHS.fhirSyncPebble,
    // One entry: the app is launched standalone only (from the Pebble phone
    // app), so `index.html` is both the connect menu and the OAuth redirect
    // target.
    requiredFiles: ['index.html'],
  },
  {
    packageName: '@wildflowerhealthio/health-viewer-web',
    // The package lives in `apps/health-viewer/health-viewer-web`; its published path is
    // `/${SECTION_PATHS.healthViewer}`.
    sourceDir: 'apps/health-viewer/health-viewer-web/dist',
    destPath: SECTION_PATHS.healthViewer,
    // One entry: the app root starts a SMART launch its URL carries, is the
    // OAuth redirect target, and serves the standalone connect menu on a bare
    // visit.
    requiredFiles: ['index.html'],
  },
  {
    packageName: '@wildflowerhealthio/synthetic-data-web',
    // The package lives in `apps/synthetic-data/synthetic-data-web`; its published path is
    // `/${SECTION_PATHS.syntheticData}`.
    sourceDir: 'apps/synthetic-data/synthetic-data-web/dist',
    destPath: SECTION_PATHS.syntheticData,
    // One entry: the app root starts a SMART launch its URL carries, is the
    // OAuth redirect target, and serves the standalone connect menu on a bare
    // visit.
    requiredFiles: ['index.html'],
  },
  {
    packageName: '@wildflowerhealthio/lifting-web',
    // The package lives in `apps/lifting/lifting-web`; its published path is
    // `/${SECTION_PATHS.lifting}`.
    sourceDir: 'apps/lifting/lifting-web/dist',
    destPath: SECTION_PATHS.lifting,
    // One entry: the app root starts a SMART launch its URL carries, is the
    // OAuth redirect target, and serves the standalone connect menu on a bare
    // visit.
    requiredFiles: ['index.html'],
  },
  {
    packageName: '@wildflowerhealthio/watch-lifts-web',
    // The package lives in `apps/watch-lifts/watch-lifts-web`; its published
    // path is `/${SECTION_PATHS.watchLifts}`.
    sourceDir: 'apps/watch-lifts/watch-lifts-web/dist',
    destPath: SECTION_PATHS.watchLifts,
    // One entry: the WatchLifts watchapp's settings page, opened from the
    // Pebble phone app with the weights in its query. Not a SMART app.
    requiredFiles: ['index.html'],
  },
  {
    packageName: '@wildflowerhealthio/ohif-viewer-web',
    // The prebuilt OHIF viewer pinned in apps/ohif-viewer-web/prebuilt.json (or
    // the stub page while nothing is pinned), with Wildflower's runtime
    // app-config.js laid over it by that package's build.
    sourceDir: 'apps/ohif-viewer-web/dist',
    destPath: SECTION_PATHS.ohifViewer,
    // The worklist page doubles as the SMART launch entry point; the bundled
    // assets hang off it.
    requiredFiles: ['index.html'],
  },
  {
    packageName: '@wildflowerhealthio/launcher-web',
    // The hosted, cross-origin copy of the launcher (#694): its `web` build
    // (`vite.config.web.ts`, `base: './'`, `outDir: 'dist-web'`, input
    // `index.html`) holds the in-memory bearer, the `?server=` picker, and the
    // `?redirect=` consumption the Pages 404.html hands back. The section places
    // that build at `/launcher/`.
    sourceDir: 'apps/launcher/launcher-web/dist-web',
    destPath: SECTION_PATHS.launcher,
    // A single SPA entry; the router derives its basepath from the page's base,
    // so the same build serves `/launcher/` and a preview's
    // `/staging/pr-<n>/launcher/`.
    requiredFiles: ['index.html'],
  },
]

/** A {@link SiteSection} resolved to absolute filesystem paths. */
interface ResolvedSection {
  readonly packageName: string
  /** Absolute directory to copy from. */
  readonly from: string
  /** Absolute directory to copy into. */
  readonly to: string
  /** Absolute paths that must exist after the copy. */
  readonly requiredPaths: readonly string[]
}

/**
 * Resolve the site layout against a repo checkout and an output directory.
 * Pure: no filesystem access, so the layout can be asserted in tests.
 */
const resolveSections = (
  repoRoot: string,
  outDir: string,
  sections: readonly SiteSection[] = siteSections
): readonly ResolvedSection[] =>
  sections.map((section) => {
    const to = join(outDir, section.destPath)
    return {
      packageName: section.packageName,
      from: join(repoRoot, section.sourceDir),
      to,
      requiredPaths: section.requiredFiles.map((file) => join(to, file)),
    }
  })

/**
 * Absolute paths that the resolved layout promises but that `exists` reports
 * as absent. An empty result means the assembled site is publishable.
 */
const missingRequiredPaths = (
  sections: readonly ResolvedSection[],
  exists: (path: string) => boolean
): readonly string[] => sections.flatMap((s) => s.requiredPaths.filter((p) => !exists(p)))

/**
 * Whether `child` is `parent` itself or nested inside it — the containment
 * invariant every destination in the layout has to satisfy so assembly can
 * never write outside the output directory.
 */
const isWithin = (parent: string, child: string): boolean => {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..')
}

/**
 * Every absolute path in the resolved layout that escapes `outDir` —
 * {@link isWithin} applied to each destination and required path. Assembly
 * checks this before it writes anything, so a layout with a traversing
 * `destPath` or `requiredFiles` entry fails instead of writing outside `dist/`.
 */
const escapingPaths = (outDir: string, sections: readonly ResolvedSection[]): readonly string[] =>
  sections.flatMap((section) =>
    [section.to, ...section.requiredPaths].filter((path) => !isWithin(outDir, path))
  )

export {
  escapingPaths,
  isWithin,
  missingRequiredPaths,
  resolveSections,
  siteSections,
  type ResolvedSection,
  type SiteSection,
}
