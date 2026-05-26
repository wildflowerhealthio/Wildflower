/**
 * Expo-backed `FileSystem.FileSystem` implementation built on
 * `expo-file-system`'s synchronous `Directory` / `File` / `Paths` APIs.
 *
 * Covers the subset of operations used by the on-device daemons: `access`,
 * `exists`, `stat`, `makeDirectory`, `remove`, `readFile`, `readFileString`,
 * `writeFile`, `writeFileString`. Unsupported methods fail with a typed
 * `SystemError` so callers see a clear "not supported by expo-effect-platform"
 * message instead of a generic `NotFound`.
 *
 * @packageDocumentation
 */
import type * as FileSystemModule from '@effect/platform/FileSystem'
import * as Context from 'effect/Context'
import * as Layer from 'effect/Layer'
import { Paths } from 'expo-file-system'
import * as internal from './internal/fileSystem.ts'

/**
 * Absolute path (no `file://` scheme) to Expo's cache directory.
 *
 * Cache dir contents may be evicted by the OS when storage runs low, so it is
 * appropriate for assets that can always be regenerated on boot (the inlined
 * SPA shell, transient bundle artefacts). Use the document directory if you
 * need persistence the OS will not reclaim.
 */
class ExpoCacheDir extends Context.Tag('expo-effect-platform/ExpoCacheDir')<
  ExpoCacheDir,
  string
>() {}

/**
 * `Layer` providing {@link ExpoCacheDir}. Resolved lazily so the layer is safe
 * to build under Jest with `expo-file-system` mocked.
 */
const ExpoCacheDirLive: Layer.Layer<ExpoCacheDir> = Layer.sync(ExpoCacheDir, () =>
  Paths.cache.uri.replace(/^file:\/\//, '')
)

/** `Layer` providing the Expo-backed `FileSystem.FileSystem` — no requirements. */
const layer: Layer.Layer<FileSystemModule.FileSystem> = internal.layer

export { layer, ExpoCacheDir, ExpoCacheDirLive }
