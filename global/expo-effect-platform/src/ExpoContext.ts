/**
 * Combined context layer providing the Expo `HttpPlatform`, the Expo-backed
 * `FileSystem.FileSystem`, and the default `Etag.Generator` + `Path` services
 * from `@effect/platform`'s `HttpServer.layerContext`.
 */
import {
  type Etag,
  type FileSystem,
  type HttpPlatform,
  HttpServer as Server,
  type Path,
} from '@effect/platform'
import { Layer } from 'effect'
import * as ExpoFileSystem from './expo-file-system.ts'
import * as ExpoHttpPlatform from './ExpoHttpPlatform.ts'

/**
 * Provides the Expo `HttpPlatform`, the Expo-backed `FileSystem.FileSystem`,
 * `Etag.Generator`, and `Path`.
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
  HttpPlatform.HttpPlatform | FileSystem.FileSystem | Etag.Generator | Path.Path
> = Layer.mergeAll(Server.layerContext, ExpoFileSystem.layer, ExpoHttpPlatform.layer)
