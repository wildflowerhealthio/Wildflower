import type { Scope } from 'effect'
import { Deferred, Effect } from 'effect'
import type { ResolvedConfig } from 'tunnel-core/daemon'

import Tunnel from './Tunnel.ts'

/**
 * Effect-friendly tunnel bring-up. Matches the daemon's `startTunnel`
 * contract: succeed with `void` once the upstream relay grants the
 * requested subdomain; `Effect.acquireRelease` registers `tunnel.close()`
 * with the surrounding scope so the daemon can tear the tunnel down by
 * closing the sub-scope.
 *
 * Validates that the granted URL matches `https://${subdomain}.${rootDomain}` —
 * if the relay falls back to a different subdomain (or returns no URL
 * at all), the Effect fails so the daemon surfaces `error` on
 * `TunnelState`. After bind-success the Effect sits on `Effect.never`,
 * keeping the scope alive until the daemon closes it.
 */
const startTunnel = ({
  subdomain,
  rootDomain,
  localPort,
}: ResolvedConfig): Effect.Effect<void, Error, Scope.Scope> =>
  Effect.gen(function* () {
    const tunnel = yield* Effect.acquireRelease(
      Effect.sync(() => new Tunnel({ port: localPort, host: `https://${rootDomain}`, subdomain })),
      (t) => Effect.sync(() => t.close())
    )

    const opened = yield* Deferred.make<string, Error>()
    yield* Effect.sync(() => {
      tunnel.once('url', (url: string) => {
        Effect.runSync(Deferred.succeed(opened, url))
      })
      tunnel.once('error', (err: Error) => {
        Effect.runSync(Deferred.fail(opened, err))
      })
      tunnel.open((openErr) => {
        if (openErr) Effect.runSync(Deferred.fail(opened, openErr))
      })
    })

    const grantedUrl = yield* Deferred.await(opened)
    const expectedUrl = `https://${subdomain}.${rootDomain}`
    if (grantedUrl !== expectedUrl) {
      return yield* Effect.fail(
        new Error(`tunnel relay granted '${grantedUrl}', expected '${expectedUrl}'`)
      )
    }

    // Tunnel is up. Hold the scope open so the daemon's
    // `Effect.acquireRelease`-style finalizer fires on reconfigure or
    // stop, not when this Effect "returns".
    return yield* Effect.never
  })

export { startTunnel }
