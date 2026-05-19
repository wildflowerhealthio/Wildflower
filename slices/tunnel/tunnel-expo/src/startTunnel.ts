import type { Scope } from 'effect'
import { Effect } from 'effect'
import type { DomainResult, ResolvedConfig } from 'tunnel-core/daemon'

import Tunnel from './Tunnel.ts'

/**
 * Effect-friendly tunnel bring-up. Matches the daemon's `startTunnel`
 * contract:
 *
 *  - opens the tunnel inside an `Effect.acquireRelease` so `tunnel.close()`
 *    fires when the daemon's sub-scope is torn down (reconfigure or stop);
 *  - awaits the upstream relay's `'url'` event for the bind signal, parses
 *    the granted host, calls `setBindResult({subdomain, rootDomain})` —
 *    the daemon writes that into `TunnelState.currentSubdomain` /
 *    `currentRootDomain`;
 *  - parks on the long-lived `'error'` listener afterwards so a post-bind
 *    cluster failure (relay reset, socket drop) propagates out as an
 *    Effect failure — the daemon catches it and records the cause in
 *    `TunnelState.error`.
 *
 * The granted host may not share `rootDomain` with the requested host (a
 * relay can redirect to an entirely different domain). We split the
 * granted hostname at the first `.` and report whatever it gives — first
 * label as subdomain, remainder as rootDomain — instead of failing. The
 * only failure mode in this Effect is a malformed URL from the relay
 * (caught by `Effect.try` around `new URL(...)`).
 */
const startTunnel = (
  { subdomain, rootDomain, localPort }: ResolvedConfig,
  setBindResult: (result: DomainResult) => Effect.Effect<void, never, never>
): Effect.Effect<never, Error, Scope.Scope> =>
  Effect.gen(function* () {
    const tunnel = yield* Effect.acquireRelease(
      Effect.sync(() => new Tunnel({ port: localPort, host: `https://${rootDomain}`, subdomain })),
      (t) => Effect.sync(() => t.close())
    )

    // Bind phase: Effect.async wires the one-shot 'url' / 'error'
    // listeners and the `open` callback in a way that respects fiber
    // interruption — the cleanup callback removes the listeners if the
    // surrounding scope is closed before bind, so we don't leak a
    // dangling handler on a soon-to-be-closed Tunnel.
    const grantedUrl = yield* Effect.async<string, Error>((resume) => {
      const onUrl = (url: string): void => resume(Effect.succeed(url))
      const onError = (err: Error): void => resume(Effect.fail(err))
      tunnel.once('url', onUrl)
      tunnel.once('error', onError)
      tunnel.open((openErr) => {
        if (openErr) resume(Effect.fail(openErr))
      })
      return Effect.sync(() => {
        tunnel.off('url', onUrl)
        tunnel.off('error', onError)
      })
    })

    const grantedHostname = yield* Effect.try({
      try: () => new URL(grantedUrl).hostname,
      catch: (cause) =>
        new Error(`tunnel relay returned malformed URL: '${grantedUrl}'`, {
          cause: cause instanceof Error ? cause : undefined,
        }),
    })

    // First label = subdomain, rest = rootDomain. A bare hostname (no
    // dot) is treated as a subdomain under an empty root — unusual but
    // not worth raising; the daemon writes whatever we report.
    const dotIdx = grantedHostname.indexOf('.')
    const result: DomainResult =
      dotIdx === -1
        ? { subdomain: grantedHostname, rootDomain: '' }
        : {
            subdomain: grantedHostname.slice(0, dotIdx),
            rootDomain: grantedHostname.slice(dotIdx + 1),
          }

    yield* setBindResult(result)

    // Park until a post-bind cluster 'error' fires or the surrounding
    // fiber is interrupted (closing the scope and so triggering
    // `tunnel.close()` via acquireRelease).
    return yield* Effect.async<never, Error>((resume) => {
      const onError = (err: Error): void => resume(Effect.fail(err))
      tunnel.on('error', onError)
      return Effect.sync(() => {
        tunnel.off('error', onError)
      })
    })
  })

export { startTunnel }
