/**
 * Expo-specific `HttpPlatform` implementation. Reads file size + mtime via
 * `expo-file-system` so it does not require an Effect `FileSystem` service.
 *
 * @packageDocumentation
 */
import type * as HttpPlatform from '@effect/platform/HttpPlatform'
import type * as Layer from 'effect/Layer'
import * as internal from './internal/httpPlatform.ts'

/** `Layer` providing the Expo `HttpPlatform` — no service requirements. */
export const layer: Layer.Layer<HttpPlatform.HttpPlatform> = internal.layer
