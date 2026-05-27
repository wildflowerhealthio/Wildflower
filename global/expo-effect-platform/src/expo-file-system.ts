/**
 * Expo-backed `FileSystem.FileSystem` implementation built on
 * `expo-file-system`'s synchronous `Directory` / `File` / `Paths` APIs.
 *
 * Covers the operations consumed by the on-device daemons: `access`,
 * `exists`, `stat`, `makeDirectory`, `remove`, `readFile`, `readFileString`,
 * `writeFile`, `writeFileString`. Unsupported methods fail with a typed
 * `SystemError` carrying `reason: 'BadResource'` and a description that
 * names the package.
 *
 * @packageDocumentation
 */
import type * as FileSystem from '@effect/platform/FileSystem'
import type * as Layer from 'effect/Layer'
import * as internal from './internal/file-system/index.ts'

/** `Layer` providing the Expo-backed `FileSystem.FileSystem` — no requirements. */
export const layer: Layer.Layer<FileSystem.FileSystem> = internal.layer
