import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Match,
  Scope,
  Stream,
  SynchronizedRef,
  pipe,
} from 'effect'

import { TunnelConfig, TunnelState, TunnelStore } from '../livestore/index.ts'

interface ResolvedConfig {
  readonly subdomain: string
  readonly rootDomain: string
  readonly localPort: number
}

/**
 * What the tunnel actually resolved to — written to
 * `TunnelState.currentSubdomain` / `currentRootDomain` by the daemon
 * once `startTunnel` succeeds. Mirrors the requested `ResolvedConfig`
 * minus `localPort` (purely local; not negotiated with the relay), and
 * can differ from the requested values when the relay redirects to a
 * different subdomain or rootDomain.
 */
interface DomainResult {
  readonly subdomain: string
  readonly rootDomain: string
}

type RunningState =
  | { readonly _tag: 'Idle' }
  /**
   * A start attempt for `config` failed. The daemon remembers the failed
   * config so it won't busy-retry on the error-commit's own stream tick
   * — only a config change or `requestedEnabled: false` re-arms it.
   */
  | { readonly _tag: 'Failed'; readonly config: ResolvedConfig }
  | {
      readonly _tag: 'Running'
      readonly tunnelScope: Scope.CloseableScope
      readonly config: ResolvedConfig
    }

const IDLE_STATE: RunningState = { _tag: 'Idle' }

type Intent =
  | {
      readonly _tag: 'StartOrReconfigure'
      readonly prev: Scope.CloseableScope | null
      readonly config: ResolvedConfig
    }
  | { readonly _tag: 'Stop'; readonly prev: Scope.CloseableScope | null }
  | { readonly _tag: 'NoOp'; readonly runningState: RunningState }

const configsEqual = (a: ResolvedConfig, b: ResolvedConfig): boolean =>
  a.subdomain === b.subdomain && a.rootDomain === b.rootDomain && a.localPort === b.localPort

const sameConfig = (runningState: RunningState, requested: ResolvedConfig): boolean =>
  runningState._tag !== 'Idle' && configsEqual(runningState.config, requested)

/**
 * Pull `(requestedEnabled, subdomain, rootDomain, localPort)` out of the
 * `TunnelConfig` singleton. Returns `null` when the row is absent or any
 * required field is null — the daemon treats either as "no work yet".
 */
const readConfig = (
  config: TunnelConfig.TunnelConfigRow | undefined
): { readonly requestedEnabled: boolean; readonly resolved: ResolvedConfig | null } => {
  if (config === undefined) return { requestedEnabled: false, resolved: null }
  const { requestedEnabled, subdomain, rootDomain, localPort } = config
  if (subdomain === null || rootDomain === null || localPort === null) {
    return { requestedEnabled, resolved: null }
  }
  return { requestedEnabled, resolved: { subdomain, rootDomain, localPort } }
}

const computeIntent = (
  runningState: RunningState,
  requestedEnabled: boolean,
  resolved: ResolvedConfig | null
): Intent => {
  if (requestedEnabled && resolved !== null && !sameConfig(runningState, resolved)) {
    return {
      _tag: 'StartOrReconfigure',
      prev: runningState._tag === 'Running' ? runningState.tunnelScope : null,
      config: resolved,
    }
  }
  if ((!requestedEnabled || resolved === null) && runningState._tag !== 'Idle') {
    return {
      _tag: 'Stop',
      prev: runningState._tag === 'Running' ? runningState.tunnelScope : null,
    }
  }
  return { _tag: 'NoOp', runningState }
}

/**
 * Long-lived daemon Effect that drives the tunnel from
 * `TunnelConfig.requestedEnabled` + `subdomain` + `rootDomain` +
 * `localPort`.
 *
 * @typeParam E - Error channel of the supplied `startTunnel`. Errors are
 *   surfaced to the UI via `TunnelState.error`; they do not propagate
 *   out of the daemon.
 * @param startTunnel - Long-lived Effect that opens the tunnel and stays
 *   alive until the upstream relay drops or the surrounding scope is
 *   closed. It calls `setBindResult(result)` exactly once when the
 *   relay confirms the bind (the daemon uses that callback as the
 *   "tunnel is up" signal and writes the `DomainResult` into
 *   `TunnelState`), then parks until either a post-bind cluster error
 *   fires (in which case the Effect fails) or the surrounding scope is
 *   closed (in which case it is interrupted). The daemon forks it into
 *   a sub-scope and provides that `Scope.Scope` as a context — the
 *   implementation should `Effect.acquireRelease` to tie its cleanup to
 *   the sub-scope.
 * @returns A scoped Effect that runs until its scope closes. The error
 *   channel is `never` because all `startTunnel` failures (pre- and
 *   post-bind) are written to `TunnelState.error` rather than thrown.
 *
 * @remarks
 *
 * Transitions mirror the local-http-server daemon: the daemon watches
 * `TunnelConfig.current$` (not `TunnelState`) since that table owns the
 * user-intent surface. On each stream tick the daemon reads the latest
 * snapshot inside a `SynchronizedRef.updateEffect` and computes an
 * `Intent` — `StartOrReconfigure` forks `startTunnel` and commits
 * `currentEnabled: true` once it signals bind; `Stop` closes the live
 * sub-scope and commits `currentEnabled: false`; `NoOp` falls through.
 *
 * Post-bind cluster failures are caught by a per-tunnel watcher fiber
 * forked into the daemon's outer scope: on a non-interrupt failure of
 * the `startTunnel` fiber after bind, the watcher closes the sub-scope,
 * commits the failure to `TunnelState.error`, and parks the daemon in
 * `Failed`. Pure interruption (from a reconfigure or daemon shutdown)
 * is ignored so the user's intent isn't clobbered by tear-down noise.
 *
 * State-reset commits live at transition sites rather than on the
 * sub-scope finalizer — so reconfiguration can close the old sub-scope
 * without those commits cascading. The daemon scope close tears down
 * any live sub-scope but does not touch the row: the user's
 * `requestedEnabled` intent must survive across daemon restarts.
 */
const runTunnelDaemon = <E>(
  startTunnel: (
    config: ResolvedConfig,
    setBindResult: (result: DomainResult) => Effect.Effect<void, never, never>
  ) => Effect.Effect<never, E, Scope.Scope>
): Effect.Effect<void, never, Scope.Scope | TunnelStore> =>
  Effect.gen(function* () {
    const store = yield* TunnelStore
    const daemonScope = yield* Effect.scope

    const commitState = (
      patch: Partial<{
        readonly currentEnabled: boolean
        readonly currentSubdomain: string | null
        readonly currentRootDomain: string | null
        readonly currentLocalPort: number | null
        readonly error: string | null
      }>
    ): Effect.Effect<void, never, never> =>
      Effect.sync(() => store.commit(TunnelState.events.tunnelStateSet(patch)))

    // Materialize the session-state default row up front — same workaround
    // local-http-server-core uses, see the comment there. The persistent
    // TunnelConfig table doesn't need it (no default row; daemon treats
    // "absent" as "nothing to do").
    yield* Effect.sync(() => store.query(TunnelState.queries.current$))

    const runningStateRef = yield* SynchronizedRef.make<RunningState>(IDLE_STATE)

    yield* Effect.addFinalizer(() =>
      SynchronizedRef.updateEffect(runningStateRef, (state) => {
        const closePrev =
          state._tag === 'Running' ? Scope.close(state.tunnelScope, Exit.void) : Effect.void
        return closePrev.pipe(Effect.as(IDLE_STATE))
      })
    )

    const newTunnel = (config: ResolvedConfig): Effect.Effect<RunningState, never, never> =>
      Effect.gen(function* () {
        const tunnelScope = yield* Scope.make()
        const deferredDomainResult = yield* Deferred.make<DomainResult, E>()
        const setBindResult = (result: DomainResult): Effect.Effect<void, never, never> =>
          Deferred.succeed(deferredDomainResult, result).pipe(Effect.asVoid)
        const startTunnelFiber = yield* pipe(
          Scope.extend(startTunnel(config, setBindResult), tunnelScope),
          Effect.tapErrorCause((cause) =>
            pipe(
              Deferred.failCause<DomainResult, E>(deferredDomainResult, cause),
              Effect.zipRight(Effect.logError('[tunnel-core] startTunnel failed', cause))
            )
          ),
          Effect.forkIn(tunnelScope)
        )

        const bindResult = yield* Effect.exit(Deferred.await(deferredDomainResult))
        if (Exit.isFailure(bindResult)) {
          yield* Scope.close(tunnelScope, Exit.void)
          yield* commitState({
            currentEnabled: false,
            currentSubdomain: null,
            currentRootDomain: null,
            currentLocalPort: null,
            error: Cause.pretty(bindResult.cause),
          })
          // Failed config is remembered so the daemon's own error-commit
          // stream tick lands as a NoOp. `requestedEnabled: true` is
          // still in TunnelConfig after the failure, so without this
          // guard the daemon would busy-retry on every tick.
          return { _tag: 'Failed', config } as const
        }

        // Use the *granted* subdomain / rootDomain — the relay may fall
        // back to a different subdomain than requested, and `TunnelState`
        // should reflect what's actually reachable. `localPort` is purely
        // local so it carries through from the requested config.
        const domainResult = bindResult.value
        yield* commitState({
          currentEnabled: true,
          currentSubdomain: domainResult.subdomain,
          currentRootDomain: domainResult.rootDomain,
          currentLocalPort: config.localPort,
          error: null,
        })

        // Post-bind watcher: if startTunnel fails *after* bind (e.g. the
        // relay drops the connection), close the sub-scope, write the
        // cause to `TunnelState.error`, and park in `Failed`. Forked
        // into the daemon's outer scope so the watcher itself survives
        // newTunnel returning, and stays alive across reconfigurations
        // until the daemon shuts down. Pure interruption is ignored —
        // a reconfigure or explicit Stop closes `tunnelScope` first,
        // which interrupts this fiber, and we don't want that to
        // clobber the user's intent with a fake error.
        yield* pipe(
          Fiber.await(startTunnelFiber),
          Effect.flatMap((exit) => {
            if (Exit.isSuccess(exit) || Cause.isInterruptedOnly(exit.cause)) {
              return Effect.void
            }
            return SynchronizedRef.updateEffect(runningStateRef, (state) => {
              if (state._tag !== 'Running' || state.tunnelScope !== tunnelScope) {
                return Effect.succeed(state)
              }
              return pipe(
                Scope.close(tunnelScope, Exit.void),
                Effect.zipRight(
                  commitState({
                    currentEnabled: false,
                    currentSubdomain: null,
                    currentRootDomain: null,
                    currentLocalPort: null,
                    error: Cause.pretty(exit.cause),
                  })
                ),
                Effect.as({ _tag: 'Failed', config } as const)
              )
            })
          }),
          Effect.forkIn(daemonScope)
        )

        return { _tag: 'Running', tunnelScope, config } as const
      })

    const startStoreWatcher = store.subscribeStream(TunnelConfig.queries.current$).pipe(
      Stream.runForEach(() =>
        SynchronizedRef.updateEffect(runningStateRef, (runningState) => {
          const { requestedEnabled, resolved } = readConfig(
            store.query(TunnelConfig.queries.current$)
          )
          const intent = computeIntent(runningState, requestedEnabled, resolved)
          return Match.value(intent).pipe(
            Match.tag('StartOrReconfigure', ({ prev, config }) => {
              const closePrev = prev === null ? Effect.void : Scope.close(prev, Exit.void)
              return closePrev.pipe(Effect.flatMap(() => newTunnel(config)))
            }),
            Match.tag('Stop', ({ prev }) => {
              const closePrev = prev === null ? Effect.void : Scope.close(prev, Exit.void)
              return closePrev.pipe(
                Effect.tap(() =>
                  commitState({
                    currentEnabled: false,
                    currentSubdomain: null,
                    currentRootDomain: null,
                    currentLocalPort: null,
                    // Clear any prior failure so the UI is not stuck on a
                    // stale error after the user toggles requestedEnabled
                    // back off.
                    error: null,
                  })
                ),
                Effect.as(IDLE_STATE)
              )
            }),
            Match.tag('NoOp', ({ runningState: state }) => Effect.succeed(state)),
            Match.exhaustive
          )
        })
      )
    )
    yield* startStoreWatcher
  })

export { runTunnelDaemon }
export type { DomainResult, ResolvedConfig }
