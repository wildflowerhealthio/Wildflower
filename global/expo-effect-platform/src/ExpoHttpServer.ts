import { type HttpServer as PlatformHttpServer } from '@effect/platform'
/**
 * Expo HTTP server implementation of `@effect/platform` HttpServer.
 */
import { type Layer } from 'effect'
import type { ServerOptions } from './ExpoEffectPlatform.types.ts'
import * as internal from './internal/httpServer.ts'

export { type ExpoFileBody } from './internal/httpServer.ts'

/**
 * Create an HttpServer layer backed by the Expo native HTTP server module.
 */
export const layer: (
  options: { port: number } & ServerOptions
) => Layer.Layer<PlatformHttpServer.HttpServer, never, never> = internal.layer
