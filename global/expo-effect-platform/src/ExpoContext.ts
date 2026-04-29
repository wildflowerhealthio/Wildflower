/**
 * Combined context layer providing the Expo `HttpPlatform` together with the
 * default `FileSystem` (noop), `Etag.Generator`, and `Path` services from
 * `@effect/platform`'s `HttpServer.layerContext`.
 *
 * @since 0.1.0
 */
import type * as Etag from '@effect/platform/Etag'
import type * as FileSystem from '@effect/platform/FileSystem'
import type * as HttpPlatform from '@effect/platform/HttpPlatform'
import * as Server from '@effect/platform/HttpServer'
import type * as Path from '@effect/platform/Path'
import * as Layer from 'effect/Layer'
import * as ExpoHttpPlatform from './ExpoHttpPlatform.ts'

/**
 * Provides the Expo `HttpPlatform` together with `FileSystem` (noop),
 * `Etag.Generator`, and `Path`.
 *
 * Built by merging `@effect/platform`'s `HttpServer.layerContext` with the
 * Expo-specific `HttpPlatform`, so `HttpServerResponse.file()` produces the
 * `ExpoFileBody` sentinel that the native bridge serves directly without
 * crossing the JS bridge as bytes.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer: Layer.Layer<
  HttpPlatform.HttpPlatform | FileSystem.FileSystem | Etag.Generator | Path.Path
> = Layer.provideMerge(ExpoHttpPlatform.layer, Server.layerContext)
