import type { Plugin } from 'vite-plus'
// A relative import of the source, not `branding-core`: this runs while Vite
// loads its config, under plain Node, where a workspace package resolves to its
// built `dist/` — which a fresh checkout doesn't have yet.
import { redirectedUrl } from '../../../../slices/branding/branding-core/src/spa-redirect.ts'

/** The parts of a dev-server request {@link deepLinkRedirect} decides on. */
interface DevRequest {
  readonly method: string | undefined
  readonly url: string | undefined
  readonly accept: string | undefined
}

/**
 * Where the `main-web` dev server should redirect `request`, or `undefined` to
 * let Vite serve it.
 *
 * @remarks
 * `main-web` takes its router basepath from the directory it was loaded at,
 * because on GitHub Pages every load lands on the app root: `404.html` sends a
 * deep link like `/app/gatekeeper/devices` to `/app/?redirect=…`, and the entry
 * restores the route (see "The 404 redirect" in `slices/branding/AGENTS.md`).
 * Vite's own SPA fallback instead serves `index.html` at the deep path itself,
 * so the app would take `/gatekeeper/devices/` for its basepath and match no
 * route. This gives the dev server the same redirect Pages performs.
 *
 * Only a browser page load (`GET`, `Accept` naming `text/html`) of a path
 * whose last segment has no file extension is redirected; module, asset and
 * Vite-internal requests pass through untouched.
 */
const deepLinkRedirect = (request: DevRequest): string | undefined => {
  if (request.method !== 'GET' || request.url === undefined) return undefined
  if (!(request.accept ?? '').includes('text/html')) return undefined
  const url = new URL(request.url, 'http://dev.invalid')
  if (url.pathname.startsWith('/@') || /\.[^/]*$/.test(url.pathname)) return undefined
  return redirectedUrl({ pathname: url.pathname, search: url.search, hash: '' }, '/')
}

/** A dev-server-only plugin applying {@link deepLinkRedirect} ahead of Vite's SPA fallback. */
const devDeepLinkRedirect = (): Plugin => ({
  name: 'wildflower-react:dev-deep-link-redirect',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const location = deepLinkRedirect({
        method: request.method,
        url: request.url,
        accept: request.headers.accept,
      })
      if (location === undefined) {
        next()
        return
      }
      response.statusCode = 302
      response.setHeader('Location', location)
      response.end()
    })
  },
})

export { deepLinkRedirect, devDeepLinkRedirect }
