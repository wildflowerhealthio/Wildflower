/**
 * Combined context layer providing the Expo `HttpPlatform`, the Expo-backed
 * `FileSystem.FileSystem`, the {@link ExpoFileSystem.ExpoCacheDir} path, and
 * the default `Etag.Generator` + `Path` services from `@effect/platform`'s
 * `HttpServer.layerContext`.
 */
import type * as Etag from '@effect/platform/Etag'
import type * as FileSystem from '@effect/platform/FileSystem'
import type * as HttpPlatform from '@effect/platform/HttpPlatform'
import * as Server from '@effect/platform/HttpServer'
import type * as Path from '@effect/platform/Path'
import * as Layer from 'effect/Layer'
import * as ExpoFileSystem from './ExpoFileSystem.ts'
import * as ExpoHttpPlatform from './ExpoHttpPlatform.ts'

/**
 * Provides the Expo `HttpPlatform`, the Expo-backed `FileSystem.FileSystem`,
 * the {@link ExpoFileSystem.ExpoCacheDir} path, `Etag.Generator`, and `Path`.
 *
 * `HttpServer.layerContext` ships a noop `FileSystem` whose `stat` fails
 * unconditionally. `Layer.mergeAll` is built on `Context.mergeAll`, which
 * walks the contexts in order and uses `Map.set` for each entry — so later
 * arguments shadow earlier ones for shared tags. Listing `Server.layerContext`
 * first and `ExpoFileSystem.layer` after it lets the Expo `FileSystem` win
 * while still pulling in the default `Etag.Generator` and `Path.Path`.
 * Callers of `HttpServerResponse.file(...)` (e.g. `StaticSpaLive`'s asset
 * fallback) and any other `FileSystem.FileSystem` consumer get a working
 * implementation backed by `expo-file-system`'s synchronous APIs.
 */
export const layer: Layer.Layer<
  | HttpPlatform.HttpPlatform
  | FileSystem.FileSystem
  | Etag.Generator
  | Path.Path
  | ExpoFileSystem.ExpoCacheDir
> = Layer.mergeAll(
  Server.layerContext,
  ExpoFileSystem.layer,
  ExpoFileSystem.ExpoCacheDirLive,
  ExpoHttpPlatform.layer
)
