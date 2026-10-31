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
//   node scripts/ci/pages-sites.ts check <name>      # fail unless its build holds its required files
//
// A plan is a JSON array of sites, written to stdout; a summary goes to
// stderr.
import { Console, Effect } from 'effect'

import {
  APP_SLUGS,
  sectionUrl,
  type HostedAppId,
  type SectionId,
} from '../../slices/branding/branding-core/src/site.ts'
import { loadAffectedPackages, type AffectedPackages, type Pkg } from '../affected-packages.ts'
import { isEntrypoint } from '../entrypoint.ts'
import { selectionFor } from './test-shards.ts'

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
 * (the TypeScript test shards' rule) would run every area — a root config or
 * lockfile change, or a change outside every package, such as this script,
 * the deploy workflows, or a book chapter and the Rust it excerpts — and
 * otherwise the sites whose package, or whose book, the changes reach through
 * the workspace dependency graph. Pure — exported for unit testing.
 */
const affectedSites = (
  affected: AffectedPackages,
  packages: readonly Pkg[]
): readonly PagesSite[] =>
  selectionFor(affected, packages)._tag === 'AllAreas'
    ? PAGES_SITES
    : PAGES_SITES.filter(
        (site) =>
          affected.affected.has(site.packageName) ||
          (site.includesBook && affected.affected.has(BOOK_PACKAGE))
      )

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
  return Effect.fail(
    new Error('Usage: pages-sites.ts plan <production|preview|teardown> | check <name>')
  )
}

if (isEntrypoint(import.meta.url))
  await Effect.runPromise(Effect.orDie(main(process.argv.slice(2))))

export type { PagesSite }
export {
  affectedSites,
  APP_PAGES_SITES,
  BOOK_PACKAGE,
  MARKETING_PAGES_SITE,
  missingRequiredFiles,
  PAGES_OWNER,
  PAGES_SITES,
}
