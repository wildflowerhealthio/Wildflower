import type { Scope } from 'effect'
import { Effect, Layer, Stream } from 'effect'
import type { LocalHttpServerStore } from 'local-http-server-core/livestore'
import { type DomainResult, type ResolvedConfig, runTunnelDaemon } from 'tunnel-core/daemon'
import type { TunnelStore } from 'tunnel-core/livestore'

import Tunnel from './Tunnel.ts'

/**
 * Effect-friendly tunnel bring-up. Matches the daemon's `startTunnel`
 * contract — returns a `Stream<DomainResult, Error, Scope.Scope>`:
 *
 *  - opens the tunnel inside an `Effect.acquireRelease` so `tunnel.close()`
 *    fires when the daemon's sub-scope is torn down (reconfigure or stop);
 *  - awaits the upstream relay's `'url'` event for the first emit — the
 *    parsed `{subdomain, rootDomain}` is what the daemon writes into
 *    `TunnelState.currentSubdomain` / `currentRootDomain`;
 *  - holds the stream open on a long-lived `'error'` listener afterwards,
 *    so a post-bind cluster failure (relay reset, socket drop) terminates
 *    the stream with that error — the daemon catches it and records the
 *    cause in `TunnelState.error`.
 *
 * The granted host may not share `rootDomain` with the requested host —
 * a relay can redirect to an entirely different domain. We split the
 * granted hostname at the first `.` and report whatever it gives (first
 * label = subdomain, remainder = rootDomain) instead of failing. The
 * only stream-terminating failure in the bind phase is a malformed URL
 * from the relay (caught by `Effect.try` around `new URL(...)`).
 *
 * The current Tunnel implementation only emits `'url'` once, so this
 * stream is in practice a one-emit-then-park; the multi-emit shape is
 * preserved against a future where the relay re-binds to a new
 * subdomain mid-session.
 */
const startTunnel = ({
  subdomain,
  rootDomain,
  localPort,
}: ResolvedConfig): Stream.Stream<DomainResult, Error, Scope.Scope> =>
  Stream.unwrapScoped(
    Effect.gen(function* () {
      // `Effect.promise` (not `Effect.sync`) so the scope finalizer actually
      // awaits the native FIN before declaring the resource released. Without
      // that await the relay sees a dropped TCP socket on iOS expiration /
      // Metro reload, keeps the subdomain lease in flight, and reassigns a
      // random name on the next launch.
      //
      // Logs are info-level (not debug) so they appear in the default
      // shutdown trace — diagnosing a stuck teardown without re-enabling
      // debug filtering is the whole point of these breadcrumbs. The release
      // closure measures elapsed ms across the native call so a slow FIN
      // shows up as a number, not a guess.
      const tunnel = yield* Effect.acquireRelease(
        Effect.sync(
          () => new Tunnel({ port: localPort, host: `https://${rootDomain}`, subdomain })
        ).pipe(Effect.tap(() => Effect.logInfo('Tunnel acquired'))),
        (t) =>
          Effect.gen(function* () {
            yield* Effect.logInfo('Tunnel release: closing')
            const startMs = yield* Effect.sync(() => Date.now())
            yield* Effect.promise(() => t.close())
            const elapsed = yield* Effect.sync(() => Date.now() - startMs)
            yield* Effect.logInfo(`Tunnel release: closed in ${elapsed}ms`)
          })
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

      const initial = yield* parseGrantedDomain(grantedUrl)

      // Post-bind: emit the initial result, then park on a long-lived
      // 'error' listener so any later cluster failure terminates the
      // stream with that error. Listener cleanup removes the handler if
      // the daemon closes the sub-scope (release fires from above).
      const tail = Stream.fromEffect(
        Effect.async<never, Error>((resume) => {
          const onError = (err: Error): void => resume(Effect.fail(err))
          tunnel.on('error', onError)
          return Effect.sync(() => {
            tunnel.off('error', onError)
          })
        })
      )

      return Stream.concat(Stream.succeed(initial), tail)
    })
  )

const parseGrantedDomain = (grantedUrl: string): Effect.Effect<DomainResult, Error, never> =>
  Effect.gen(function* () {
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
    return dotIdx === -1
      ? { subdomain: grantedHostname, rootDomain: '' }
      : {
          subdomain: grantedHostname.slice(0, dotIdx),
          rootDomain: grantedHostname.slice(dotIdx + 1),
        }
  })

/**
 * long-lived fiber that drives `TunnelConfig` → `tunnel-expo`'s `startTunnel`
 * → `TunnelState`. `Layer.scopedDiscard` ties the daemon's lifetime to the
 * surrounding scope; the daemon's own error channel is `never` (failures
 * are persisted into `TunnelState.error` rather than thrown), so the
 * composer doesn't see them.
 */
const TunnelDaemon: Layer.Layer<never, never, TunnelStore | LocalHttpServerStore> =
  Layer.scopedDiscard(Effect.forkScoped(runTunnelDaemon(startTunnel)))

export { startTunnel, TunnelDaemon }
