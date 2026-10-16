import { join } from 'node:path'

import {
  APP_SLUGS,
  sectionUrl,
  SITE_ORIGIN,
  type HostedAppId,
} from '@wildflowerhealthio/branding-core'

/**
 * The paths on the apex, `https://wildflowerhealth.io`, that redirect to each
 * hosted app's own origin: a stub at `/<path>/` sends the browser on with the
 * query and fragment it arrived with, so bookmarks and SMART launch URLs that
 * name the apex keep working.
 */
const APEX_REDIRECT_PATHS: Readonly<Record<HostedAppId, string>> = {
  medications: 'medications',
  importer: 'importer',
  serverDocs: 'server-docs',
  ohifViewer: 'ohif-viewer',
  fhirSyncPebble: 'fhir-sync-pebble',
  plots: 'health-viewer',
  syntheticData: 'synthetic-data',
  strength: 'lifting',
  watchLifts: 'watch-lifts',
  launcher: 'launcher',
  authorization: 'authorization',
}

/** Every hosted app, in {@link APP_SLUGS} order. */
const HOSTED_APP_IDS: readonly HostedAppId[] = Object.keys(APP_SLUGS).filter(
  (id): id is HostedAppId => Object.hasOwn(APP_SLUGS, id)
)

/** One hosted app's published site: its own Pages repository's `gh-pages`. */
interface PublishedAppSite {
  readonly app: HostedAppId
  /** Absolute directory of the app's build in the assembled site. */
  readonly from: string
  /** Absolute directory its published site is staged in. */
  readonly to: string
  /** The custom domain its `CNAME` names: the host of its own origin. */
  readonly customDomain: string
}

/** One redirect stub on the apex site. */
interface ApexRedirect {
  readonly app: HostedAppId
  /** Absolute path of the stub's `index.html`. */
  readonly stubPath: string
  /** The apex path the stub is served at, slash-wrapped: `/health-viewer/`. */
  readonly fromPath: string
  /** The app's own origin, slash-terminated. */
  readonly to: string
}

/** The staged published sites, resolved against an output directory. */
interface PublishedSites {
  /** The apex site's directory, which the Pages deploy of this repository publishes. */
  readonly apexDir: string
  /** The app directories of the assembled site, left out of the apex. */
  readonly appDirsInAssembly: readonly string[]
  readonly redirects: readonly ApexRedirect[]
  readonly apps: readonly PublishedAppSite[]
}

/**
 * Where each published site is staged, from the assembled site at
 * `assembledDir`: the apex under `<outDir>/apex`, holding the assembled site
 * minus the apps plus a redirect stub at each of {@link APEX_REDIRECT_PATHS},
 * and each app under `<outDir>/apps/<slug>`. Pure: no filesystem access.
 */
const resolvePublishedSites = (assembledDir: string, outDir: string): PublishedSites => {
  const apexDir = join(outDir, 'apex')
  return {
    apexDir,
    appDirsInAssembly: HOSTED_APP_IDS.map((app) => join(assembledDir, APP_SLUGS[app])),
    redirects: HOSTED_APP_IDS.map((app) => ({
      app,
      stubPath: join(apexDir, APEX_REDIRECT_PATHS[app], 'index.html'),
      fromPath: `/${APEX_REDIRECT_PATHS[app]}/`,
      to: sectionUrl(app),
    })),
    apps: HOSTED_APP_IDS.map((app) => ({
      app,
      from: join(assembledDir, APP_SLUGS[app]),
      to: join(outDir, 'apps', APP_SLUGS[app]),
      customDomain: new URL(sectionUrl(app)).host,
    })),
  }
}

/**
 * The page at an old apex path: it replaces itself with the app's own origin,
 * keeping the query and fragment. A deep link the apex's `404.html` handed
 * over (`?redirect=/health-viewer/x`) loses the old path on the way, so the
 * app's own redirect restoration reads the route it carries.
 *
 * @param fromPath - The apex path the stub is served at, slash-wrapped.
 * @param to - The app's own origin, slash-terminated.
 */
const redirectStubHtml = (fromPath: string, to: string): string => `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Redirecting&hellip;</title>
    <meta name="robots" content="noindex" />
    <link rel="canonical" href="${to}" />
    <noscript><meta http-equiv="refresh" content="0; url=${to}" /></noscript>
    <script>
      ;(function () {
        var from = ${JSON.stringify(fromPath)}
        var target = new URL(${JSON.stringify(to)})
        var params = new URLSearchParams(window.location.search)
        var deepLink = params.get('redirect')
        if (deepLink !== null && deepLink.indexOf(from) === 0) {
          params.set('redirect', '/' + deepLink.slice(from.length))
        }
        target.search = params.toString()
        target.hash = window.location.hash
        window.location.replace(target.href)
      })()
    </script>
  </head>
  <body>
    <p>This app has moved to <a href="${to}">${to}</a>.</p>
  </body>
</html>
`

/** The apex site's own origin, which its `CNAME` names. */
const APEX_CUSTOM_DOMAIN = new URL(SITE_ORIGIN).host

export {
  APEX_CUSTOM_DOMAIN,
  APEX_REDIRECT_PATHS,
  HOSTED_APP_IDS,
  redirectStubHtml,
  resolvePublishedSites,
  type ApexRedirect,
  type PublishedAppSite,
  type PublishedSites,
}
