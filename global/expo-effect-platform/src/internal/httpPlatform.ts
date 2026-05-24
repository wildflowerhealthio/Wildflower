import * as Error from '@effect/platform/Error'
import type * as FileSystem from '@effect/platform/FileSystem'
import * as Headers from '@effect/platform/Headers'
import * as HttpPlatform from '@effect/platform/HttpPlatform'
import * as ServerResponse from '@effect/platform/HttpServerResponse'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { File } from 'expo-file-system'
import type { ExpoFileBody } from './httpServer.ts'

/**
 * `@effect/platform`'s `HttpPlatform.make` helper calls `fs.stat(path)` on the
 * Effect `FileSystem` service to derive `etag` / `last-modified` /
 * `content-length` before it ever delegates to the platform-specific impl.
 * `expo-effect-platform` doesn't ship a real `FileSystem` (the only one in
 * scope inside `HttpServer.layerContext` is `layerNoop`, whose `stat` fails
 * unconditionally), so going through that wrapper would make every
 * `HttpServerResponse.file(...)` reject with `SystemError NotFound`.
 *
 * Instead, build the `HttpPlatform` tag directly and read size + mtime via
 * `expo-file-system`'s synchronous `File` accessors. Failures surface as the
 * same `Error.SystemError` shape the generic wrapper would have emitted, so
 * callers (e.g. `StaticSpaLive` in `wildflower-server`) see consistent errors.
 */

/**
 * `expo-file-system`'s `File` constructor expects a `file:///` URI.
 * `HttpServerResponse.file()` callers go through `Path.Path` resolvers that
 * strip the scheme (see `apps/wildflower-expo/src/daemons/http-server.ts`), so
 * add it back here when missing.
 */
const fileFromPath = (path: string): File =>
  new File(path.startsWith('file://') ? path : `file://${path}`)

/**
 * Minimal MIME map covering the file types a typical embedded SPA serves
 * (HTML shell + bundled CSS/JS + common image and font formats). Mirrors the
 * Node platform's `mime.getType(path)` fallback so callers don't have to
 * thread `Content-Type` headers through every `HttpServerResponse.file()`
 * call. Kept inline rather than depending on `mime` because this package
 * sits under `global/` and stays project-agnostic.
 */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'application/javascript; charset=utf-8',
  mjs: 'application/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  wasm: 'application/wasm',
  pdf: 'application/pdf',
}

const mimeForPath = (path: string): string | undefined => {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return undefined
  const ext = path.slice(dot + 1).toLowerCase()
  return MIME_BY_EXTENSION[ext]
}

const buildFileResponse = (
  path: string,
  options: (ServerResponse.Options.WithContent & FileSystem.StreamOptions) | undefined
): ServerResponse.HttpServerResponse => {
  const file = fileFromPath(path)
  if (!file.exists) {
    throw new Error.SystemError({
      module: 'FileSystem',
      method: 'stat',
      reason: 'NotFound',
      description: 'No such file or directory',
      pathOrDescriptor: path,
    })
  }
  const size = file.size
  const mtimeMs = file.modificationTime ?? 0
  const start = Number(options?.offset ?? 0)
  const end = options?.bytesToRead !== undefined ? start + Number(options.bytesToRead) : undefined

  let headers = options?.headers ? Headers.fromInput(options.headers) : Headers.empty
  // Match `Etag.layerWeak.fromFileInfo`: `W/"<size-hex>-<mtime-ms-hex>"`.
  headers = Headers.set(headers, 'etag', `W/"${size.toString(16)}-${mtimeMs.toString(16)}"`)
  if (mtimeMs > 0) {
    headers = Headers.set(headers, 'last-modified', new Date(mtimeMs).toUTCString())
  }
  // Infer Content-Type from the file extension when the caller didn't supply
  // one. Mirrors `@effect/platform-node`'s `mime.getType(path)` fallback so
  // `HttpServerResponse.file(absolutePath)` "just works" for an SPA shell
  // (text/html), bundled assets, etc. — otherwise the browser treats the
  // response as `application/octet-stream` and offers a download instead of
  // rendering. `ServerResponseImpl` copies `body.contentType` onto the
  // response headers, which is what `respondToRequestWithFile` forwards to
  // native.
  const contentType = headers['content-type'] ?? mimeForPath(path) ?? 'application/octet-stream'
  const contentLength = end !== undefined ? end - start : size - start
  const body: ExpoFileBody = { expoFilePath: path, start, end }
  return ServerResponse.raw(body, {
    status: options?.status ?? 200,
    statusText: options?.statusText,
    headers,
    contentType,
    contentLength,
  })
}

const make: HttpPlatform.HttpPlatform = {
  [HttpPlatform.TypeId]: HttpPlatform.TypeId,
  fileResponse(path, options) {
    return Effect.try({
      try: () => buildFileResponse(path, options),
      catch: (cause) =>
        cause instanceof Error.SystemError
          ? cause
          : new Error.SystemError({
              module: 'FileSystem',
              method: 'stat',
              reason: 'Unknown',
              description: cause instanceof globalThis.Error ? cause.message : String(cause),
              pathOrDescriptor: path,
              cause,
            }),
    })
  },
  fileWebResponse(_file, options) {
    return Effect.succeed(
      ServerResponse.raw('fileWebResponse is not supported in expo-effect-platform v1', {
        status: 501,
        statusText: options?.statusText ?? 'Not Implemented',
        headers: options?.headers ? Headers.fromInput(options.headers) : Headers.empty,
      })
    )
  },
}

const layer: Layer.Layer<HttpPlatform.HttpPlatform> = Layer.succeed(HttpPlatform.HttpPlatform, make)

export { make, layer }
