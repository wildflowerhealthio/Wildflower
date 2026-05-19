import type { Scope } from 'effect'
import { Deferred, Effect } from 'effect'
import type { GrantedConfig, ResolvedConfig } from 'tunnel-core/daemon'

import Tunnel from './Tunnel.ts'

/**
 * Effect-friendly tunnel bring-up. Matches the daemon's `startTunnel`
 * contract: succeed with the actually-granted `{subdomain, rootDomain}`
 * once the upstream relay confirms the bind, then return. The daemon
 * uses the success value as the "tunnel is up" signal and writes the
 * granted values into `TunnelState`.
 *
 * `Effect.acquireRelease` registers `tunnel.close()` with the
 * surrounding scope so the daemon can tear the tunnel down by closing
 * the sub-scope — there is no need for the bring-up Effect to "park"
 * (e.g. on `Effect.never`); shape-wise this mirrors
 * `local-http-server-core`'s `startServer`.
 *
 * If the relay grants a different subdomain than requested the returned
 * `GrantedConfig` carries the granted value — the daemon writes that to
 * `TunnelState.currentSubdomain`, no error is raised. The only failure
 * mode here is a malformed URL from the relay.
 */
const startTunnel = ({
  subdomain,
  rootDomain,
  localPort,
}: ResolvedConfig): Effect.Effect<GrantedConfig, Error, Scope.Scope> =>
  Effect.gen(function* () {
    const tunnel = yield* Effect.acquireRelease(
      Effect.sync(() => new Tunnel({ port: localPort, host: `https://${rootDomain}`, subdomain })),
      (t) => Effect.sync(() => t.close())
    )

    const deferredTunnelUrl = yield* Deferred.make<string, Error>()
    yield* Effect.sync(() => {
      tunnel.once('url', (url: string) => {
        Effect.runSync(Deferred.succeed(deferredTunnelUrl, url))
      })
      tunnel.once('error', (err: Error) => {
        Effect.runSync(Deferred.fail(deferredTunnelUrl, err))
      })
      tunnel.open((openErr) => {
        if (openErr) Effect.runSync(Deferred.fail(deferredTunnelUrl, openErr))
      })
    })

    const grantedUrl = yield* Deferred.await(deferredTunnelUrl)

    // Parse the granted URL into the granted subdomain. The relay holds
    // `rootDomain` fixed (we connected to that host) but may hand back a
    // different subdomain. `URL` throws on a malformed input, so wrap it.
    const grantedHostname = yield* Effect.try({
      try: () => new URL(grantedUrl).hostname,
      catch: () => new Error(`tunnel relay returned malformed URL: '${grantedUrl}'`),
    })
    const suffix = `.${rootDomain}`
    if (!grantedHostname.endsWith(suffix)) {
      return yield* Effect.fail(
        new Error(`granted hostname '${grantedHostname}' does not end with '${suffix}'`)
      )
    }
    const grantedSubdomain = grantedHostname.slice(0, grantedHostname.length - suffix.length)
    return { subdomain: grantedSubdomain, rootDomain }
  })

export { startTunnel }
