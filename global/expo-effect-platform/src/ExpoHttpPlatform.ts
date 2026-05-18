import type * as FileSystem from '@effect/platform/FileSystem'
import type * as HttpPlatform from '@effect/platform/HttpPlatform'
/**
 * Expo-specific HttpPlatform implementation.
 *
 * Handles `fileResponse` by passing file paths directly to the native layer
 * (no bytes cross the JS bridge for large files).
 */
import type * as Layer from 'effect/Layer'
import * as internal from './internal/httpPlatform.ts'

export const layer: Layer.Layer<HttpPlatform.HttpPlatform, never, FileSystem.FileSystem> =
  internal.layer
