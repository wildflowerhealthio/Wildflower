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
 */
class WebAssetsDir extends Context.Tag('wildflower-server/WebAssetsDir')<WebAssetsDir, string>() {}

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
 * Determine a safe relative asset path from an HTTP request pathname.
 *
 * Returns `Option.some(rel)` for a sanitised path (no leading slash, no
 * `..` segments, no `\0`, no malformed encoding); `Option.none()` when
 * no safe path exists. The handler bounces `none()` to `/`. The empty
 * string `''` represents the SPA root and falls through to `index.html`
 * via the `tryFindAssetFileForPath` stat-miss branch.
 */
const sanitizeRequestPath = (pathname: string): Option.Option<string> => {
  if (pathname.includes('\0')) return Option.none()
  if (containsParentSegment(pathname)) return Option.none()
  // Collapse leading slashes: `new URL('//foo/bar', base)` treats `//foo`
  // as a protocol-relative authority and would drop the first segment.
  const cleaned = pathname.replace(/^\/+/, '/')
  const normalized = new URL(cleaned, 'http://placeholder/').pathname
  const stripped = normalized.replace(/^\/+/, '').replace(/\/+/g, '/')
  if (stripped === '.') return Option.some('')
  return Option.some(stripped)
}

/**
 * Resolve a sanitised relative path to an absolute asset-file path on
 * disk. Returns `Option.none()` when no real file lives there or when
 * the resolved path escapes `webAssetsDir` (defense in depth against
 * encoded-slash escapes that decode to `..` inside the platform `Path`
 * implementation). Caller falls back to `index.html` on `none()`.
 */
const tryFindAssetFileForPath = (
  webAssetsDir: string,
  relPath: string
): Effect.Effect<Option.Option<string>, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const candidate = path.resolve(webAssetsDir, relPath)
    const baseAbsolute = path.resolve(webAssetsDir)
    const baseWithSep = baseAbsolute.endsWith(path.sep) ? baseAbsolute : `${baseAbsolute}${path.sep}`
    if (candidate !== baseAbsolute && !candidate.startsWith(baseWithSep)) {
      return Option.none()
    }
    const stat = yield* Effect.option(fs.stat(candidate))
    if (Option.isSome(stat) && stat.value.type === 'File') {
      return Option.some(candidate)
    }
    return Option.none()
  })

const makeStaticSpaLayer = (webAssetsDir: string): Layer.Layer<never, never, never> =>
  HttpApiBuilder.Router.use((router) => {
    const handler = Effect.gen(function* () {
      const path = yield* Path.Path
      const indexFile = path.join(webAssetsDir, 'index.html')

      const request = yield* HttpServerRequest.HttpServerRequest
      const url = new URL(request.url, 'http://localhost')

      const relPath = sanitizeRequestPath(url.pathname)
      if (Option.isNone(relPath)) return HttpServerResponse.redirect('/')

      const assetFile = yield* tryFindAssetFileForPath(webAssetsDir, relPath.value)
      return yield* HttpServerResponse.file(Option.getOrElse(assetFile, () => indexFile))
    })
    // GET serves the asset; HEAD returns the same headers without the
    // body. Other methods (POST, PUT, …) on an unmatched path should
    // 404 rather than fall through to the SPA shell — masking client
    // bugs by serving 200 OK is worse than the obvious failure.
    return router.get('*', handler).pipe(Effect.zipRight(router.head('*', handler)))
  })

/**
 * SPA fallback. Serves real files under the configured `WebAssetsDir`
 * verbatim (assets, etc.) and falls back to `index.html` for any
 * unmatched GET/HEAD path so deep links rehydrate the router on
 * refresh. Registered on `HttpApiBuilder.Router` (the same router
 * `HttpApiBuilder.api` endpoints land on), so the API's specific paths
 * win and only unmatched GET/HEAD requests fall through here.
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

export { StaticSpaLive, WebAssetsDir, sanitizeRequestPath, tryFindAssetFileForPath }
