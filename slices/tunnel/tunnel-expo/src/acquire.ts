import { Effect, type Scope } from 'effect'
import { start } from './localtunnel.ts'

interface AcquireOptions {
  readonly port: number
  readonly subdomain: string
  readonly fallbackOrigin: string
}

/**
 * Acquire a localtunnel for `port` and register its `close()` as a
 * finalizer on the surrounding `Scope`. The resolved value is the URL
 * the relay granted (or the supplied `fallbackOrigin` when the relay
 * returns no URL).
 *
 * Closing the surrounding scope tears the tunnel down — composing apps
 * use this to ensure tunnels go down on server restart or shutdown.
 */
const acquire = ({
  port,
  subdomain,
  fallbackOrigin,
}: AcquireOptions): Effect.Effect<string, Error, Scope.Scope> =>
  Effect.gen(function* () {
    const tunnel = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => start({ port, subdomain }),
        catch: (cause) => new Error(`localtunnel handshake failed: ${String(cause)}`),
      }),
      (t) => Effect.sync(() => t.close())
    )
    return tunnel.url ?? fallbackOrigin
  })

export { acquire }
export type { AcquireOptions }
