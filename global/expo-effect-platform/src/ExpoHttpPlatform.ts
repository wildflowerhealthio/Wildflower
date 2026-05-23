import type * as HttpPlatform from '@effect/platform/HttpPlatform'
/**
 * Expo-specific HttpPlatform implementation.
 *
 * Handles `fileResponse` by passing file paths directly to the native layer
 * (no bytes cross the JS bridge for large files). Reads file size + mtime
 * via `expo-file-system` so it does not depend on Effect's `FileSystem`
 * service (the only one wired in scope on Expo is `layerNoop`, whose `stat`
 * unconditionally fails).
 */
import type * as Layer from 'effect/Layer'
import * as internal from './internal/httpPlatform.ts'

export const layer: Layer.Layer<HttpPlatform.HttpPlatform> = internal.layer
