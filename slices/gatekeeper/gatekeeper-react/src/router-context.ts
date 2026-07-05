import { useRouteContext } from '@tanstack/react-router'
import { type Layer } from 'effect'
import { type GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import { type BaseRouterContext } from 'shared-structures-react'

import { buildGatekeeperClientLayer } from './client/gatekeeper-client.ts'

type RuntimeLayer = BaseRouterContext.RuntimeLayerWith<GatekeeperHttpApiClient>
type RunAuthed = BaseRouterContext.RunAuthedWith<GatekeeperHttpApiClient>

/**
 * Slice-local router-context — `BaseRouterContext.RouterContextWith`
 * narrowed to this slice's client, plus the optional host-threaded
 * `localGrantedScopes`. `awaitAuthReady` is inherited only to keep this
 * structural context a faithful subset of the host app's `RouterContext`;
 * gatekeeper loaders don't read it — the gate guarantees the token before the
 * loader runs.
 */
type RouterContext = BaseRouterContext.RouterContextWith<GatekeeperHttpApiClient> & {
  /**
   * The host's granted-scope string (e.g. `system/*.cruds wildflower/*.cruds`),
   * threaded from the Tauri shell's `tauri-shared-config.json` so the WebView's
   * device-login request asks for exactly the scopes gatekeeper-rust seeds for
   * the first-party client. Omitted on web/standalone builds, where
   * {@link useGatekeeperLocalGrantedScopes} returns `undefined` and the caller
   * falls back to the canonical default.
   */
  readonly localGrantedScopes?: string
}

/**
 * The gatekeeper slice's client layer, ready for the app to merge into
 * its composed `runtimeLayer` over `BaseRouterContext.RuntimeLayer`
 * (`HttpClient`). Tokenless — see {@link buildGatekeeperClientLayer}.
 */
const sliceRuntimeLayer: Layer.Layer<
  GatekeeperHttpApiClient,
  never,
  Layer.Layer.Success<BaseRouterContext.RuntimeLayer>
> = buildGatekeeperClientLayer()

/**
 * The fully-composed `runtimeLayer` from router context, for the two
 * gatekeeper call sites that aren't one-shot Promises and so can't go
 * through `runAuthed`/`useSuspenseQuery`:
 *
 *   - `NeedsAuthMessage` — the RFC 8628 device flow runs a long-lived
 *     fiber with retry + interrupt-on-unmount.
 *   - `oauth-polling` — `pollAuthorizationStatus` is a `Stream` that
 *     emits `pending` heartbeats until a terminal status.
 *
 * Both `Effect.provide` / `Stream.provideSomeLayer` this layer onto a
 * gatekeeper Effect/Stream and run it imperatively (via `react-kitchen-sink`'s
 * generic `useStream` / `Effect.runFork`). The annotated `select` re-narrows
 * the result when the slice's router isn't registered (standalone build),
 * where `useRouteContext()` would otherwise widen to `any` — no cast.
 */
const useGatekeeperRuntimeLayer = (): RuntimeLayer =>
  useRouteContext({ from: '__root__', select: (context: RouterContext) => context.runtimeLayer })

/**
 * The host's granted-scope string from router context (see
 * {@link RouterContext.localGrantedScopes}). `NeedsAuthMessage` requests exactly
 * this set at device login so it matches the first-party client's seeded
 * `allowed_scopes`. `undefined` on standalone/web builds where the host context
 * doesn't carry it — the caller falls back to the canonical default.
 */
const useGatekeeperLocalGrantedScopes = (): string | undefined =>
  useRouteContext({
    from: '__root__',
    select: (context: RouterContext) => context.localGrantedScopes,
  })

export { sliceRuntimeLayer, useGatekeeperLocalGrantedScopes, useGatekeeperRuntimeLayer }
export type { RouterContext, RunAuthed, RuntimeLayer }
