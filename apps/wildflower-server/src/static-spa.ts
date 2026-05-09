import {
  FileSystem,
  HttpApiBuilder,
  HttpServerRequest,
  HttpServerResponse,
  Path,
} from '@effect/platform'
import { Context, Effect, Layer, Option } from 'effect'

/**
 * Absolute path to the directory containing the SPA bundle (`index.html`
 * plus the asset tree to serve verbatim). The platform-specific runner
 * provides a value via `Layer.succeed(WebAssetsDir, …)` — for
 * `wildflower-node`, that's `wildflower-react/web-assets`.
 *
 * Surfaced as a Tag so this package stays cross-platform: any host that
 * can supply a string path and an `@effect/platform`
 * `FileSystem`/`Path` implementation can serve the SPA, no `node:fs`
 * dependency required.
 */
class WebAssetsDir extends Context.Tag('wildflower-server/WebAssetsDir')<WebAssetsDir, string>() {}

// Reject any pathname that contains a literal `..` segment OR a
// percent-encoded variant (`%2e%2e`, mixed case, etc.). The URL constructor
// would otherwise collapse `/foo/../bar` to `/bar` at normalisation time,
// silently turning a traversal probe into a "harmless" path that lands in
// the SPA fallback. The handler bounces these to `/` instead — keeps a
// confused legitimate user moving forward, and a probe doesn't get to
// render the SPA shell at its chosen URL.
// `decodeURIComponent` per segment catches encoded variants; malformed
// percent-encoding is itself suspicious and rejected.
const containsParentSegment = (pathname: string): boolean => {
  for (const segment of pathname.split('/')) {
    try {
      if (decodeURIComponent(segment) === '..') return true
    } catch {
      return true
    }
  }
  return false
}

/**
 * Map an HTTP request pathname to one of three buckets:
 *
 * - `none()` — sketchy. Traversal attempts (`..` segments, including
 *   percent-encoded variants), null-byte injection, malformed
 *   percent-encoding. The handler responds with a 302 to `/`.
 * - `some('')` — the SPA root (`''`, `'/'`). The handler joins this to
 *   the assets directory, the file-stat misses (a directory, not a
 *   file), and the response falls through to `index.html`.
 * - `some('foo/bar')` — a normal candidate path. The handler stat-checks
 *   it; on hit it serves the file, on miss it falls through to
 *   `index.html` so React Router can claim the deep link.
 */
const parsePathToAssetFile = (pathname: string): Option.Option<string> => {
  if (pathname.includes('\0')) return Option.none()
  if (containsParentSegment(pathname)) return Option.none()
  // Collapse leading slashes to a single `/` first: `new URL('//foo/bar', base)`
  // treats `//foo` as a protocol-relative authority (host=foo), which would
  // silently drop the first segment of an HTTP request like `GET //assets/app.js`.
  const cleaned = pathname.replace(/^\/+/, '/')
  const normalized = new URL(cleaned, 'http://placeholder/').pathname
  const stripped = normalized.replace(/^\/+/, '').replace(/\/+/g, '/')
  // `URL` collapses `'.'`-only paths (`'/.'`, `'/./.'`) to `'.'`. Treat
  // those as the SPA root rather than trying to look up a `.` directory.
  if (stripped === '.') return Option.some('')
  return Option.some(stripped)
}

/**
 * Resolve a validated relative path to an absolute asset-file path on
 * disk, or `Option.none()` when no real file lives there. The handler
 * defaults to `index.html` on `none()` so deep links rehydrate the SPA.
 *
 * Takes a `relPath` already produced by `parsePathToAssetFile` — this
 * function does no validation, only the file-stat check.
 */
const tryFindAssetFileForPath = (
  webAssetsDir: string,
  relPath: string
): Effect.Effect<Option.Option<string>, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const candidate = path.join(webAssetsDir, relPath)
    const stat = yield* Effect.option(fs.stat(candidate))
    if (Option.isSome(stat) && stat.value.type === 'File') {
      return Option.some(candidate)
    }
    return Option.none()
  })

const makeStaticSpaLayer = (webAssetsDir: string): Layer.Layer<never, never, never> =>
  HttpApiBuilder.Router.use((router) =>
    router.get(
      '*',
      Effect.gen(function* () {
        const path = yield* Path.Path
        const indexFile = path.join(webAssetsDir, 'index.html')

        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, 'http://localhost')

        const relPath = parsePathToAssetFile(url.pathname)
        // Sketchy path: bounce to `/` rather than render the SPA shell at
        // the requested URL. A confused user lands somewhere working; a
        // probe doesn't get a 200 OK at a path it picked.
        if (Option.isNone(relPath)) return HttpServerResponse.redirect('/')

        const assetFile = yield* tryFindAssetFileForPath(webAssetsDir, relPath.value)
        return yield* HttpServerResponse.file(Option.getOrElse(assetFile, () => indexFile))
      })
    )
  )

/**
 * SPA fallback. Serves real files under the configured `WebAssetsDir`
 * verbatim (assets, etc.) and falls back to `index.html` for any unmatched
 * path so deep links rehydrate the router on refresh. Registered as a
 * `GET '*'` on `HttpApiBuilder.Router` (the same router
 * `HttpApiBuilder.api` endpoints land on), so the API's specific paths
 * win and only unmatched GETs fall through here.
 *
 * Reads `WebAssetsDir` at Layer-build time via `Layer.unwrapEffect` so
 * the route handler closes over a plain string. This sidesteps
 * `HttpApiBuilder.Router.use`'s constraint that route-handler
 * requirements fit `DefaultServices | Provided` — the Tag never appears
 * in the handler's R, only in the outer Layer's R.
 */
const StaticSpaLive: Layer.Layer<never, never, WebAssetsDir> = Layer.unwrapEffect(
  Effect.map(WebAssetsDir, makeStaticSpaLayer)
)

export { StaticSpaLive, WebAssetsDir, parsePathToAssetFile }
