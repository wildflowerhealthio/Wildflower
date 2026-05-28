/**
 * Expo-specific `HttpPlatform` implementation. Reads file size + mtime via
 * `expo-file-system` so it does not require an Effect `FileSystem` service.
 *
 * @packageDocumentation
 */
import { type HttpPlatform } from '@effect/platform'
import { type Layer } from 'effect'
import * as internal from './internal/httpPlatform.ts'

/** `Layer` providing the Expo `HttpPlatform` — no service requirements. */
export const layer: Layer.Layer<HttpPlatform.HttpPlatform> = internal.layer
