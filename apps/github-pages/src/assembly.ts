import { join, relative, sep } from 'node:path'

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
    packageName: 'marketing-website',
    sourceDir: 'apps/marketing-website/dist',
    destPath: '',
    // `CNAME` (copied from the marketing site's `public/`) has to land at the
    // artifact root or GitHub Pages drops the custom-domain setting on deploy.
    requiredFiles: ['index.html', 'CNAME'],
  },
  {
    packageName: 'medications-app',
    // The medications app builds into the vendored self-hosted-apps tree (it
    // also ships as a Tauri resource from there); this package consumes that
    // output rather than redirecting it.
    sourceDir: 'slices/apps/self-hosted-apps/medication',
    destPath: 'medications-app',
    // Two entries: the EHR launch endpoint and the app root (the redirect target,
    // which also serves the standalone connect menu on a bare visit).
    requiredFiles: ['index.html', 'launch.html'],
  },
  {
    packageName: 'wildflower-server-docs',
    sourceDir: 'apps/wildflower-server-docs/dist',
    destPath: 'wildflower-server-docs',
    // A single-page console; the bundled assets hang off it.
    requiredFiles: ['index.html'],
  },
  {
    packageName: 'wildflower-web-trace',
    // Same arrangement as the medications app: the Web Trace app builds into
    // the vendored self-hosted-apps tree it ships from as a Tauri resource, and
    // this package copies that output rather than redirecting it.
    sourceDir: 'slices/apps/self-hosted-apps/web-trace',
    destPath: 'web-trace-app',
    // Two entries: the EHR launch endpoint and the app root (the redirect target,
    // which also serves the standalone connect menu on a bare visit).
    requiredFiles: ['index.html', 'launch.html'],
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
