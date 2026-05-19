import type { EventEmitter } from 'node:events'

import type { Scope } from 'effect'
import { Effect, Layer, Stream } from 'effect'
import localtunnel from 'localtunnel'
import { type DomainResult, type ResolvedConfig, runTunnelDaemon } from 'tunnel-core/daemon'
import type { TunnelStore } from 'tunnel-core/livestore'

/**
 * Minimal contract over the `localtunnel` npm package surface that
 * `startTunnel` actually depends on. The `localtunnel` types expose a
 * larger `Tunnel` interface (HeaderHostTransformer plumbing, internal
 * `tunnelCluster`, etc.) — we narrow to just what the daemon contract
 * needs so a test fake doesn't have to spin up a real cluster.
 *
 * `url` is populated by the time the returned `Promise<Tunnel>` resolves
 * (the npm client awaits `open()` internally), so the daemon's "bind
 * signal" is the resolution of the promise rather than a deferred event.
 * Subsequent cluster failures surface as `'error'` events on the
 * EventEmitter; clean teardown is `close()`.
 */
interface OpenTunnelHandle extends EventEmitter {
  readonly url: string
  close: () => void
}

interface OpenTunnelOpts {
  readonly port: number
  readonly host: string
  readonly subdomain: string
}

/**
 * Open-tunnel indirection. The default implementation calls into the
 * `localtunnel` npm package; tests inject a fake to drive bind / error /
 * close transitions without a real relay. The injected impl receives
 * the daemon's `ResolvedConfig`-derived `OpenTunnelOpts`.
 */
type OpenTunnel = (opts: OpenTunnelOpts) => Promise<OpenTunnelHandle>

const defaultOpenTunnel: OpenTunnel = (opts) => localtunnel({ ...opts })

/**
 * Effect-friendly tunnel bring-up. Matches the daemon's `startTunnel`
 * contract — returns a `Stream<DomainResult, Error, Scope.Scope>`:
 *
 *  - opens the tunnel inside an `Effect.acquireRelease` so the underlying
 *    `Tunnel.close()` fires when the daemon's sub-scope is torn down
 *    (reconfigure or stop);
 *  - awaits `localtunnel`'s `open()` for the first emit — `localtunnel`
 *    resolves its returned promise only after the relay assigns a URL,
 *    so by the time we read `handle.url` the bind has already happened;
 *  - holds the stream open on a long-lived `'error'` listener afterwards,
 *    so a post-bind cluster failure (relay reset, socket drop) terminates
 *    the stream with that error — the daemon catches it and records the
 *    cause in `TunnelState.error`.
 *
 * The granted URL may not share `rootDomain` with the requested host —
 * a relay can redirect to an entirely different domain. We split the
 * granted hostname at the first `.` and report whatever it gives (first
 * label = subdomain, remainder = rootDomain) instead of failing. The
 * only stream-terminating failure in the bind phase is a malformed URL
 * from the relay (caught by `Effect.try` around `new URL(...)`).
 *
 * The `localtunnel` client only resolves once — it does not re-emit a
 * new `'url'` if the cluster reconnects to a different subdomain — so
 * this stream is in practice a one-emit-then-park. The multi-emit shape
 * is preserved against a future where re-binds are surfaced.
 */
const startTunnel = (
  cfg: ResolvedConfig,
  openTunnel: OpenTunnel = defaultOpenTunnel
): Stream.Stream<DomainResult, Error, Scope.Scope> =>
  Stream.unwrapScoped(
    Effect.gen(function* () {
      const handle = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            openTunnel({
              port: cfg.localPort,
              host: `https://${cfg.rootDomain}`,
              subdomain: cfg.subdomain,
            }),
          catch: (cause) =>
            cause instanceof Error ? cause : new Error(`localtunnel open failed: ${String(cause)}`),
        }),
        (h) => Effect.sync(() => h.close())
      )

      const initial = yield* parseGrantedDomain(handle.url)

      // Post-bind: emit the initial result, then park on a long-lived
      // 'error' listener so any later cluster failure terminates the
      // stream with that error. Listener cleanup removes the handler if
      // the daemon closes the sub-scope (release fires from above).
      const tail = Stream.fromEffect(
        Effect.async<never, Error>((resume) => {
          const onError = (err: Error): void => resume(Effect.fail(err))
          handle.on('error', onError)
          return Effect.sync(() => {
            handle.off('error', onError)
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
 * long-lived fiber that drives `TunnelConfig` → `tunnel-node`'s `startTunnel`
 * → `TunnelState`. `Layer.scopedDiscard` ties the daemon's lifetime to the
 * `WildflowerServerLive` scope; the daemon's own error channel is `never`
 * (failures are persisted into `TunnelState.error` rather than thrown),
 * so the surrounding `Layer.launch` doesn't see them.
 */
const TunnelDaemon: Layer.Layer<never, never, TunnelStore> = Layer.scopedDiscard(
  Effect.forkScoped(runTunnelDaemon(startTunnel))
)

export { startTunnel, TunnelDaemon }
export type { OpenTunnel, OpenTunnelHandle, OpenTunnelOpts }
