#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The sites this repository publishes on GitHub Pages, and the plans the
// deploy workflows build and publish. Each hosted app is published from the
// `gh-pages` branch of its own repository, `wildflowerhealthio/<slug>-web`,
// at `https://<slug>.wildflowerhealth.io/` (`APP_SLUGS`), and its PR previews
// under `pr-<n>/` of that same branch; the marketing site is published at the
// apex by this repository's Pages, and its PR previews under `pr-<n>/` of
// `wildflowerhealthio/staging`. scripts/ci/deploy-pages-sites.sh builds and
// publishes a plan's sites.
//
//   node scripts/ci/pages-sites.ts plan production   # every app (the apex deploys on its own)
//   node scripts/ci/pages-sites.ts plan preview      # the sites a branch's changes can affect
//   node scripts/ci/pages-sites.ts plan teardown     # every site with previews
//   node scripts/ci/pages-sites.ts groups preview    # the preview plan, split for its jobs
//   node scripts/ci/pages-sites.ts groups teardown   # the teardown plan, split for its jobs
//   node scripts/ci/pages-sites.ts check <name>      # fail unless its build holds its required files
//
// A plan is a JSON array of sites, written to stdout; a summary goes to
// stderr. `groups` writes the GitHub Actions matrix pr-preview.yml's deploy
// and teardown jobs fan out over, `{ include: [{ group, name, sites }, ...] }`:
// the plan's sites in at most `PREVIEW_GROUP_COUNT` groups, each a job of its
// own (see `previewGroups`).
import { Console, Effect } from 'effect'

import {
  APP_SLUGS,
  sectionUrl,
  type HostedAppId,
  type SectionId,
} from '../../slices/branding/branding-core/src/site.ts'
import { loadAffectedPackages, type AffectedPackages, type Pkg } from '../affected-packages.ts'
import { isEntrypoint } from '../entrypoint.ts'
import { packUnits, selectionFor } from './test-shards.ts'

/** scripts/ci/ sits two levels under the repo root. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * The book (apps/wildflower-site/book-web), which the marketing site's build
 * carries at `book/`.
 */
const BOOK_PACKAGE = '@wildflowerhealthio/book-web'

/** The GitHub organization every Pages repository belongs to. */
const PAGES_OWNER = 'wildflowerhealthio'

/** One published site, and the Pages branch its builds go to. */
interface PagesSite {
  readonly section: SectionId
  /** The app's slug, or `marketing`: names the site in job names, the preview comment and `check`. */
  readonly name: string
  /** The workspace package whose `build` produces {@link buildDir}. */
  readonly packageName: string
  /** Repo-root-relative directory holding the package's build output. */
  readonly buildDir: string
  /**
   * Files that MUST exist under {@link buildDir} after the build, relative to
   * it, so a silently empty build fails the deploy instead of publishing.
   */
  readonly requiredFiles: readonly string[]
  /**
   * The repository variable holding the app's Sentry DSN, which its build
   * reads under the same name; empty for a site that reports nothing.
   */
  readonly sentryDsnVariable: string
  /** The repository, under {@link PAGES_OWNER}, whose branch Pages serves the site from. */
  readonly pagesRepository: string
  readonly pagesBranch: string
  /** The slash-terminated URL the branch's root is served at; a preview is `<siteUrl>pr-<n>/`. */
  readonly siteUrl: string
  /**
   * Whether the site's preview carries the book at `book/`, built from
   * {@link BOOK_PACKAGE} after the site's own build, so a change reaching the
   * book previews the site too. (The apex deploy adds the book itself.)
   */
  readonly includesBook: boolean
}

/** What differs between the hosted apps' sites. */
interface AppSite {
  readonly packageName: string
  readonly buildDir: string
  readonly sentryDsnVariable: string
  /** The site's {@link PagesSite.requiredFiles}, when more than its `index.html`. */
  readonly requiredFiles?: readonly string[]
}

const APP_SITES: Readonly<Record<HostedAppId, AppSite>> = {
  medications: {
    packageName: '@wildflowerhealthio/medications-web',
    buildDir: 'apps/medications/medications-web/dist',
    sentryDsnVariable: 'VITE_SENTRY_DSN_MEDICATIONS_WEB',
  },
  importer: {
    packageName: '@wildflowerhealthio/importer-web',
    buildDir: 'apps/importer-web/dist',
    sentryDsnVariable: 'VITE_SENTRY_DSN_IMPORTER_WEB',
  },
  serverDocs: {
    packageName: '@wildflowerhealthio/server-docs-web',
    buildDir: 'apps/server-docs-web/dist',
    sentryDsnVariable: '',
  },
  ohifViewer: {
    // The prebuilt OHIF viewer pinned in apps/ohif-viewer-web/prebuilt.json
    // (or the stub page while nothing is pinned), with Wildflower's runtime
    // app-config.js laid over it by that package's build.
    packageName: '@wildflowerhealthio/ohif-viewer-web',
    buildDir: 'apps/ohif-viewer-web/dist',
    sentryDsnVariable: '',
  },
  fhirSyncPebble: {
    packageName: '@wildflowerhealthio/fhir-sync-pebble-web',
    buildDir: 'apps/fhir-sync-pebble/fhir-sync-pebble-web/dist',
    sentryDsnVariable: 'VITE_SENTRY_DSN_FHIR_SYNC_PEBBLE_WEB',
  },
  plots: {
    packageName: '@wildflowerhealthio/plots-web',
    buildDir: 'apps/plots/plots-web/dist',
    sentryDsnVariable: 'VITE_SENTRY_DSN_PLOTS_WEB',
  },
  syntheticData: {
    packageName: '@wildflowerhealthio/synthetic-data-web',
    buildDir: 'apps/synthetic-data/synthetic-data-web/dist',
    sentryDsnVariable: 'VITE_SENTRY_DSN_SYNTHETIC_DATA_WEB',
  },
  strength: {
    packageName: '@wildflowerhealthio/strength-web',
    buildDir: 'apps/strength/strength-web/dist',
    sentryDsnVariable: 'VITE_SENTRY_DSN_STRENGTH_WEB',
  },
  watchLifts: {
    packageName: '@wildflowerhealthio/watch-lifts-web',
    buildDir: 'apps/watch-lifts/watch-lifts-web/dist',
    sentryDsnVariable: '',
  },
  launcher: {
    // The hosted launcher's `web` build (`vite.config.web.ts`).
    packageName: '@wildflowerhealthio/launcher-web',
    buildDir: 'apps/launcher/launcher-web/dist-web',
    sentryDsnVariable: 'VITE_SENTRY_DSN_LAUNCHER_WEB',
  },
  authorization: {
    packageName: '@wildflowerhealthio/authorization-web',
    buildDir: 'apps/authorization/authorization-web/dist',
    sentryDsnVariable: 'VITE_SENTRY_DSN_AUTHORIZATION_WEB',
  },
  appCatalog: {
    packageName: '@wildflowerhealthio/app-catalog-web',
    buildDir: 'apps/app-catalog/app-catalog-web/dist',
    sentryDsnVariable: '',
    // The HALO catalog at `/apps`, and the same bytes at `/apps.json`, which
    // Pages serves as `application/json`: `app-catalog-core-js`'s
    // `CATALOG_PATH` and `CATALOG_JSON_PATH`, which pages-sites.test.ts holds
    // these to.
    requiredFiles: ['index.html', 'apps', 'apps.json'],
  },
}

/** Every hosted app, in {@link APP_SLUGS} order. */
const HOSTED_APP_IDS: readonly HostedAppId[] = Object.keys(APP_SLUGS).filter(
  (id): id is HostedAppId => Object.hasOwn(APP_SLUGS, id)
)

/**
 * Each hosted app's site. One entry each: the app root starts a SMART launch
 * its URL carries, is the OAuth redirect target, and serves the standalone
 * connect menu (or, for the console, the viewer and the WatchLifts settings
 * page, the one page there is).
 */
const APP_PAGES_SITES: readonly PagesSite[] = HOSTED_APP_IDS.map((app) => ({
  section: app,
  name: APP_SLUGS[app],
  ...APP_SITES[app],
  requiredFiles: APP_SITES[app].requiredFiles ?? ['index.html'],
  pagesRepository: `${APP_SLUGS[app]}-web`,
  pagesBranch: 'gh-pages',
  siteUrl: sectionUrl(app),
  includesBook: false,
}))

/**
 * The marketing site. Its production build is deployed to the apex by
 * deploy-github-pages.yml directly, so its Pages branch holds only previews:
 * `wildflowerhealthio/staging`, which Pages serves from `main`.
 */
const MARKETING_PAGES_SITE: PagesSite = {
  section: 'marketing',
  name: 'marketing',
  packageName: '@wildflowerhealthio/marketing-site-web',
  buildDir: 'apps/wildflower-site/marketing-site-web/dist',
  // `CNAME` (from the marketing site's `public/`) has to land at the root of
  // the apex deploy or GitHub Pages drops the custom domain. The policy pages
  // are app-store and legal requirements, and the redirect pages and the
  // `404.html` that hands them deep links keep the apps' apex paths working.
  // `suggested_apps.json` (also from `public/`) is the published list of
  // suggested SMART apps, whose schema is `suggested-apps-core-js`.
  requiredFiles: [
    'index.html',
    'CNAME',
    '404.html',
    'privacy-policy/index.html',
    'consumer-health-data/index.html',
    'terms/index.html',
    'deletion/index.html',
    'health-viewer/index.html',
    'lifting/index.html',
    'suggested_apps.json',
  ],
  sentryDsnVariable: '',
  pagesRepository: 'staging',
  pagesBranch: 'main',
  siteUrl: `https://${PAGES_OWNER}.github.io/staging/`,
  includesBook: true,
}

/** Every site, apps first. */
const PAGES_SITES: readonly PagesSite[] = [...APP_PAGES_SITES, MARKETING_PAGES_SITE]

/**
 * The sites a branch's changes can affect: every site when `selectionFor`
 * (the TypeScript test plan's rule) would run every project — a root config or
 * lockfile change, or a change outside every package, such as this script,
 * the deploy workflows, or a book chapter and the Rust it excerpts — and
 * otherwise the sites whose package, or whose book, the changes reach through
 * the workspace dependency graph. Pure — exported for unit testing.
 */
const affectedSites = (
  affected: AffectedPackages,
  packages: readonly Pkg[]
): readonly PagesSite[] =>
  selectionFor(affected, packages)._tag === 'AllProjects'
    ? PAGES_SITES
    : PAGES_SITES.filter(
        (site) =>
          affected.affected.has(site.packageName) ||
          (site.includesBook && affected.affected.has(BOOK_PACKAGE))
      )

/**
 * The most jobs pr-preview.yml's deploy, and its teardown, split the sites
 * among. Every job pays about 50 seconds of setup (checkout, Vite+, install)
 * and the account shares 20 concurrent runners across every workflow, so the
 * sites share two jobs rather than taking one each.
 */
const PREVIEW_GROUP_COUNT = 2

/**
 * Rough seconds each site's preview takes to build and publish on a CI
 * runner, by site name: the weights the groups balance. Read off the
 * per-site job history in October 2026, less each job's setup, and rounded;
 * they only need to rank the sites, so re-measure when the groups drift well
 * out of balance rather than on every change. The marketing site's includes
 * the book and installing mdbook.
 */
const PREVIEW_SITE_SECONDS: ReadonlyMap<string, number> = new Map([
  ['app-catalog', 10],
  ['authorization', 70],
  ['fhir-sync-pebble', 50],
  ['importer', 80],
  ['launcher', 80],
  ['marketing', 55],
  ['medications', 75],
  ['ohif-viewer', 20],
  ['plots', 75],
  ['server-docs', 20],
  ['strength', 55],
  ['synthetic-data', 85],
  ['watch-lifts', 10],
])

/** The weight of a site missing from {@link PREVIEW_SITE_SECONDS}: about the median site's. */
const DEFAULT_PREVIEW_SITE_SECONDS = 55

/** Rough seconds a site's preview takes: {@link PREVIEW_SITE_SECONDS}, else the default. */
const previewSiteSeconds = (site: PagesSite): number =>
  PREVIEW_SITE_SECONDS.get(site.name) ?? DEFAULT_PREVIEW_SITE_SECONDS

/** One of pr-preview.yml's deploy or teardown jobs: a matrix entry. */
interface PreviewGroup {
  /** The group's number, from 1: fixed per site, it names the job's concurrency group. */
  readonly group: number
  /** `<group>/<count>`, shown in the job name. */
  readonly name: string
  readonly sites: readonly PagesSite[]
}

/**
 * Every site's group: {@link PAGES_SITES} packed by
 * {@link PREVIEW_SITE_SECONDS} onto {@link PREVIEW_GROUP_COUNT} groups,
 * heaviest first onto the lightest (the TypeScript test shards' packing).
 * Packed over every site, not over a plan's, so a site is in the same group
 * whatever else a branch changes: a preview's deploy and the PR's teardown
 * then hold the same per-group concurrency lock for each site, and never
 * touch a site's `pr-<n>/` at once.
 */
const SITE_GROUPS: ReadonlyMap<string, number> = new Map(
  packUnits(
    PAGES_SITES.map((site) => ({ label: site.name, seconds: previewSiteSeconds(site) })),
    PREVIEW_GROUP_COUNT
  ).flatMap((units, index) => units.map(({ label }) => [label, index + 1] as const))
)

/**
 * A plan's sites in their groups ({@link SITE_GROUPS}), leaving out a group
 * none of them is in: none for no sites, one when they all fall in one group.
 * Each group lists its sites in {@link PAGES_SITES} order. Balanced for every
 * site, so a plan of some sites can fall unevenly, never slower than one job
 * for them all. Pure — exported for unit testing.
 */
const previewGroups = (sites: readonly PagesSite[]): readonly PreviewGroup[] =>
  Array.from({ length: PREVIEW_GROUP_COUNT }, (_, index) => index + 1).flatMap((group) => {
    const groupSites = sites.filter((site) => SITE_GROUPS.get(site.name) === group)
    return groupSites.length === 0
      ? []
      : [{ group, name: `${group}/${PREVIEW_GROUP_COUNT}`, sites: groupSites }]
  })

/** The required files of `site` missing from its build, as repo-root-relative paths. */
const missingRequiredFiles = (
  site: PagesSite,
  exists: (path: string) => boolean
): readonly string[] =>
  site.requiredFiles
    .map((file) => `${site.buildDir}/${file}`)
    .filter((path) => !exists(join(REPO_ROOT, path)))

const formatPlan = (plan: string, sites: readonly PagesSite[]): string =>
  `pages ${plan}: ${sites.length === 0 ? 'no sites' : sites.map((site) => site.name).join(', ')}`

const plan = (which: string): Effect.Effect<readonly PagesSite[], Error> => {
  switch (which) {
    case 'production':
      return Effect.succeed(APP_PAGES_SITES)
    case 'teardown':
      return Effect.succeed(PAGES_SITES)
    case 'preview':
      return Effect.map(loadAffectedPackages(REPO_ROOT), ({ packages, affectedPackages }) =>
        affectedSites(affectedPackages, packages)
      )
    default:
      return Effect.fail(new Error(`Unknown plan "${which}": production, preview or teardown`))
  }
}

const check = (name: string): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const site = PAGES_SITES.find((candidate) => candidate.name === name)
    if (site === undefined) return yield* Effect.fail(new Error(`No Pages site named "${name}"`))
    const missing = missingRequiredFiles(site, existsSync)
    if (missing.length > 0) {
      return yield* Effect.fail(
        new Error(`The ${name} build is missing required files:\n${missing.join('\n')}`)
      )
    }
    return yield* Console.error(`The ${name} build at ${site.buildDir} holds its required files`)
  })

const main = (args: readonly string[]): Effect.Effect<void, Error> => {
  const [command, argument = ''] = args
  if (command === 'check') return check(argument)
  if (command === 'plan') {
    return Effect.gen(function* () {
      const sites = yield* plan(argument)
      yield* Console.error(formatPlan(argument, sites))
      yield* Console.log(JSON.stringify(sites))
    })
  }
  if (command === 'groups') {
    // Production runs a job per app (deploy-github-pages.yml), not groups.
    if (argument === 'production') {
      return Effect.fail(new Error('Only the preview and teardown plans have groups'))
    }
    return Effect.gen(function* () {
      const groups = previewGroups(yield* plan(argument))
      if (groups.length === 0) yield* Console.error(formatPlan(argument, []))
      for (const { name, sites } of groups) {
        yield* Console.error(formatPlan(`${argument} ${name}`, sites))
      }
      yield* Console.log(JSON.stringify({ include: groups }))
    })
  }
  return Effect.fail(
    new Error(
      'Usage: pages-sites.ts plan <production|preview|teardown> | groups <preview|teardown> | check <name>'
    )
  )
}

if (isEntrypoint(import.meta.url))
  await Effect.runPromise(Effect.orDie(main(process.argv.slice(2))))

export type { PagesSite, PreviewGroup }
export {
  affectedSites,
  APP_PAGES_SITES,
  BOOK_PACKAGE,
  MARKETING_PAGES_SITE,
  missingRequiredFiles,
  PAGES_OWNER,
  PAGES_SITES,
  PREVIEW_GROUP_COUNT,
  PREVIEW_SITE_SECONDS,
  previewGroups,
  previewSiteSeconds,
}
