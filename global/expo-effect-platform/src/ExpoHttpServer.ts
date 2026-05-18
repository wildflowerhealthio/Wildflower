import type * as Server from '@effect/platform/HttpServer'
/**
 * Expo HTTP server implementation of `@effect/platform` HttpServer.
 */
import type * as Layer from 'effect/Layer'
import type { ServerOptions } from './ExpoEffectPlatform.types.ts'
import * as internal from './internal/httpServer.ts'

export { type ExpoFileBody } from './internal/httpServer.ts'

/**
 * Create an HttpServer layer backed by the Expo native HTTP server module.
 */
export const layer: (options: { port: number } & ServerOptions) => Layer.Layer<Server.HttpServer> =
  internal.layer
