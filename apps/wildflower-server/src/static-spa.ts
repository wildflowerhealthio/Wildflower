import {
  FileSystem,
  HttpApiBuilder,
  HttpServerRequest,
  HttpServerResponse,
  Path,
} from '@effect/platform'
import { Context, Effect, Layer, Option } from 'effect'

/** Absolute path to the directory containing the SPA bundle (`index.html` plus the asset tree). */
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
 * Sanitise an HTTP request pathname to a safe relative asset path.
 *
 * @returns `Option.some(rel)` for a clean path (no leading slash, no
 * `..` segments, no `\0`, no malformed encoding); `Option.none()` when
 * no safe path exists. The empty string `''` represents the SPA root.
 */
const sanitizeRequestPath = (pathname: string): Option.Option<string> => {
  if (pathname.includes('\0')) return Option.none()
  if (containsParentSegment(pathname)) return Option.none()
  // `new URL('//foo/bar', base)` treats `//foo` as a protocol-relative authority.
  const cleaned = pathname.replace(/^\/+/, '/')
  // `new URL` throws "Invalid URL" on some inputs the property test
  // explored (e.g. a lone backslash). Treat any unparseable pathname
  // as "no safe path".
  let normalized: string
  try {
    normalized = new URL(cleaned, 'http://placeholder/').pathname
  } catch {
    return Option.none()
  }
  const stripped = normalized.replace(/^\/+/, '').replace(/\/+/g, '/')
  if (stripped === '.') return Option.some('')
  return Option.some(stripped)
}

/**
 * Resolve a sanitised relative path to an absolute asset-file path on disk.
 *
 * @returns `Option.some(absolute)` when a real file lives at the resolved
 * path; `Option.none()` when no file exists or when the resolved path
 * escapes `webAssetsDir`. Defense in depth against encoded-slash escapes
 * that decode to `..` inside the platform `Path` implementation.
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
    const baseWithSep = baseAbsolute.endsWith(path.sep)
      ? baseAbsolute
      : `${baseAbsolute}${path.sep}`
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
    // Only GET/HEAD fall back to the SPA shell; other methods on an unmatched path 404.
    return router.get('*', handler).pipe(Effect.zipRight(router.head('*', handler)))
  })

/**
 * SPA fallback. Serves real files under {@link WebAssetsDir} verbatim
 * and falls back to `index.html` for any unmatched GET/HEAD path so
 * deep links rehydrate the router on refresh. Registered on
 * `HttpApiBuilder.Router` so the API's specific paths win.
 *
 * @remarks
 * Reads `WebAssetsDir` at Layer-build time via `Layer.unwrapEffect` so
 * the route handler closes over a plain string — sidesteps
 * `HttpApiBuilder.Router.use`'s constraint that route-handler
 * requirements fit `DefaultServices | Provided`.
 */
const StaticSpaLive: Layer.Layer<never, never, WebAssetsDir> = Layer.unwrapEffect(
  Effect.map(WebAssetsDir, makeStaticSpaLayer)
)

export { StaticSpaLive, WebAssetsDir, sanitizeRequestPath, tryFindAssetFileForPath }
