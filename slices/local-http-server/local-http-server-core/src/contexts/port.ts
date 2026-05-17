import { Context } from 'effect'

/**
 * Loopback port the local HTTP server binds to. Provided by the host
 * (`Layer.succeed(Port, PORT)`); consumed by the `local-http-server-expo`
 * daemon to derive `localOrigin` and start the server.
 */
class Port extends Context.Tag('local-http-server-core/Port')<Port, number>() {}

export { Port }
