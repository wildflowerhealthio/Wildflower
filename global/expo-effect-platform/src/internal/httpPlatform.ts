import * as PlatformError from '@effect/platform/Error'
import type * as FileSystem from '@effect/platform/FileSystem'
import * as Headers from '@effect/platform/Headers'
import * as HttpPlatform from '@effect/platform/HttpPlatform'
import * as ServerResponse from '@effect/platform/HttpServerResponse'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { File } from 'expo-file-system'
import type { ExpoFileBody } from './httpServer.ts'

/**
 * Wraps a bare absolute path in the `file:///` URI form `expo-file-system`'s
 * `File` constructor requires. Idempotent for inputs that already carry the
 * scheme.
 */
const fileFromPath = (path: string): File =>
  new File(path.startsWith('file://') ? path : `file://${path}`)

/**
 * Covers a subset of `@effect/platform-node`'s `mime.getType` fallback —
 * enough for an embedded SPA shell (HTML + bundled CSS/JS + common image,
 * font, and wasm assets). Kept inline rather than depending on `mime` so this
 * package stays project-agnostic.
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
): Effect.Effect<ServerResponse.HttpServerResponse, PlatformError.SystemError> =>
  Effect.gen(function* () {
    const file = fileFromPath(path)
    if (!file.exists) {
      return yield* Effect.fail(
        new PlatformError.SystemError({
          module: 'FileSystem',
          method: 'stat',
          reason: 'NotFound',
          description: 'No such file or directory',
          pathOrDescriptor: path,
        })
      )
    }
    const size = file.size
    const mtimeMs: number | null = file.modificationTime ?? null
    const start = Number(options?.offset ?? 0)
    const end = options?.bytesToRead !== undefined ? start + Number(options.bytesToRead) : undefined

    let headers = options?.headers ? Headers.fromInput(options.headers) : Headers.empty
    // Match `Etag.layerWeak.fromFileInfo`: `W/"<size-hex>-<mtime-ms-hex>"`.
    headers = Headers.set(
      headers,
      'etag',
      `W/"${size.toString(16)}-${(mtimeMs ?? 0).toString(16)}"`
    )
    if (mtimeMs !== null) {
      headers = Headers.set(headers, 'last-modified', new Date(mtimeMs).toUTCString())
    }
    // Default Content-Type from the extension; without it browsers treat the
    // response as a download instead of rendering an SPA shell.
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
  })

/**
 * `HttpPlatform` implementation built directly against `expo-file-system`'s
 * synchronous `File` accessors.
 *
 * @remarks
 * `@effect/platform`'s `HttpPlatform.make` helper calls `fs.stat(path)` on
 * the Effect `FileSystem` service to derive `etag` / `last-modified` /
 * `content-length` before delegating to the platform-specific impl. No real
 * `FileSystem` is in scope inside `HttpServer.layerContext` on Expo (the
 * wired-in `layerNoop`'s `stat` fails unconditionally), so going through
 * that wrapper would make every `HttpServerResponse.file(...)` reject with
 * `SystemError NotFound`. This impl reads size + mtime via `File` directly
 * and synthesises matching `Error.SystemError` shapes on failure so callers
 * see consistent errors.
 *
 * Content-Type is forwarded to native via `response.headers['content-type']`
 * — `ServerResponseImpl` copies `body.contentType` onto the response
 * headers, which is what `respondToRequestWithFile` then reads.
 */
const make = HttpPlatform.HttpPlatform.of({
  [HttpPlatform.TypeId]: HttpPlatform.TypeId,
  fileResponse: buildFileResponse,
  fileWebResponse(_file, options) {
    return Effect.succeed(
      ServerResponse.raw('fileWebResponse is not supported in expo-effect-platform v1', {
        status: 501,
        statusText: options?.statusText ?? 'Not Implemented',
        headers: options?.headers ? Headers.fromInput(options.headers) : Headers.empty,
      })
    )
  },
})

/** `Layer` providing the Expo `HttpPlatform` — no service requirements. */
const layer: Layer.Layer<HttpPlatform.HttpPlatform> = Layer.succeed(HttpPlatform.HttpPlatform, make)

export { make, layer }
