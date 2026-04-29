import type * as Etag from '@effect/platform/Etag'
import type * as FileSystem from '@effect/platform/FileSystem'
import type * as HttpPlatform from '@effect/platform/HttpPlatform'
import * as Server from '@effect/platform/HttpServer'
import type * as Path from '@effect/platform/Path'
/**
 * Combined context layer providing HttpPlatform and Etag services.
 *
 * For v1, FileSystem is not provided — use `@effect/platform`'s noop
 * FileSystem via `HttpServer.layerContext` if needed.
 *
 * @since 0.1.0
 */
import type * as Layer from 'effect/Layer'

/**
 * Provides `HttpPlatform`, `FileSystem` (noop), `Etag.Generator`, and `Path`.
 *
 * Uses the noop FileSystem and default Path from `@effect/platform`'s
 * `layerContext`. For file serving via `HttpServerResponse.file()`, the
 * ExpoHttpPlatform layer intercepts and passes file paths to native.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer: Layer.Layer<
  HttpPlatform.HttpPlatform | FileSystem.FileSystem | Etag.Generator | Path.Path
> = Server.layerContext
