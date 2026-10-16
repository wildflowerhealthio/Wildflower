import { APP_SLUGS, sectionUrl, type HostedAppId } from '@wildflowerhealthio/branding-core'

/**
 * The paths on the apex, `https://wildflowerhealth.io`, each hosted app was
 * served from before it moved to its own origin. Bookmarks and SMART launch
 * URLs still name them, so this site's build puts a redirect page at each one
 * (`scripts/write-app-redirects.ts`).
 */
const MOVED_APP_PATHS: Readonly<Record<HostedAppId, string>> = {
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

/** One redirect page in this site's build. */
interface AppRedirect {
  readonly app: HostedAppId
  /** The page's file, relative to the build's root: `health-viewer/index.html`. */
  readonly file: string
  /** The page's HTML. */
  readonly html: string
}

/**
 * The page at a moved app's old path: it replaces itself with the app's own
 * origin, keeping the query and fragment. A deep link the apex's `404.html`
 * handed over (`?redirect=/health-viewer/x`) loses the old path on the way,
 * so the app's own redirect restoration reads the route it carries.
 *
 * @param fromPath - The apex path the page is served at, slash-wrapped.
 * @param to - The app's own origin, slash-terminated.
 */
const redirectPageHtml = (fromPath: string, to: string): string => `<!doctype html>
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

/** Every moved app's redirect page, in `APP_SLUGS` order. */
const APP_REDIRECTS: readonly AppRedirect[] = Object.keys(APP_SLUGS)
  .filter((id): id is HostedAppId => Object.hasOwn(APP_SLUGS, id))
  .map((app) => ({
    app,
    file: `${MOVED_APP_PATHS[app]}/index.html`,
    html: redirectPageHtml(`/${MOVED_APP_PATHS[app]}/`, sectionUrl(app)),
  }))

export { APP_REDIRECTS, MOVED_APP_PATHS, redirectPageHtml, type AppRedirect }
