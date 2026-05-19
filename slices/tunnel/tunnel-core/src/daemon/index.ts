import {
  Cause,
  Deferred,
  Effect,
  Either,
  Exit,
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
 * What the upstream relay actually granted — written to
 * `TunnelState.currentSubdomain` / `currentRootDomain` by the daemon
 * once `startTunnel` succeeds. Mirrors the requested `ResolvedConfig`
 * minus `localPort` (purely local; not negotiated with the relay), and
 * can differ from the requested values if the relay falls back to a
 * different subdomain.
 */
interface GrantedConfig {
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
 * @param startTunnel - Effect that opens the tunnel. It must succeed
 *   with the actually-granted `{subdomain, rootDomain}` once the upstream
 *   relay has confirmed the bind (the daemon uses that as the "tunnel is
 *   up" signal and writes the granted values into `TunnelState`). The
 *   daemon forks it into a sub-scope and provides that `Scope.Scope` as
 *   a context — long-running implementations should
 *   `Effect.acquireRelease` to register their cleanup with the
 *   sub-scope.
 * @returns A scoped Effect that runs until its scope closes. The error
 *   channel is `never` because all `startTunnel` failures are written to
 *   `TunnelState.error` rather than thrown.
 *
 * @remarks
 *
 * Transitions mirror the local-http-server daemon: the daemon watches
 * `TunnelConfig.current$` (not `TunnelState`) since that table owns the
 * user-intent surface. On each stream tick the daemon reads the latest
 * snapshot inside a `SynchronizedRef.updateEffect` and computes an
 * `Intent` — `StartOrReconfigure` forks `startTunnel` and commits
 * `currentEnabled: true` once it succeeds; `Stop` closes the live
 * sub-scope and commits `currentEnabled: false`; `NoOp` falls through.
 *
 * State-reset commits live at transition sites rather than on the
 * sub-scope finalizer — so reconfiguration can close the old sub-scope
 * without those commits cascading. The daemon scope close tears down
 * any live sub-scope but does not touch the row: the user's
 * `requestedEnabled` intent must survive across daemon restarts.
 */
const runTunnelDaemon = <E>(
  startTunnel: (config: ResolvedConfig) => Effect.Effect<GrantedConfig, E, Scope.Scope>
): Effect.Effect<void, never, Scope.Scope | TunnelStore> =>
  Effect.gen(function* () {
    const store = yield* TunnelStore

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
        const grantedDeferred = yield* Deferred.make<GrantedConfig, E>()
        yield* pipe(
          Scope.extend(startTunnel(config), tunnelScope),
          Effect.tap((granted) => Deferred.succeed(grantedDeferred, granted)),
          Effect.tapErrorCause((cause) =>
            pipe(
              Deferred.failCause<GrantedConfig, E>(grantedDeferred, cause),
              Effect.zipRight(Effect.logError('[tunnel-core] startTunnel failed', cause))
            )
          ),
          Effect.forkIn(tunnelScope)
        )

        const openResult = yield* Effect.either(Deferred.await(grantedDeferred))
        if (Either.isLeft(openResult)) {
          yield* Scope.close(tunnelScope, Exit.void)
          yield* commitState({
            currentEnabled: false,
            currentSubdomain: null,
            currentRootDomain: null,
            currentLocalPort: null,
            error: Cause.pretty(Cause.fail(openResult.left)),
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
        const granted = openResult.right
        yield* commitState({
          currentEnabled: true,
          currentSubdomain: granted.subdomain,
          currentRootDomain: granted.rootDomain,
          currentLocalPort: config.localPort,
          error: null,
        })
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
export type { GrantedConfig, ResolvedConfig }
