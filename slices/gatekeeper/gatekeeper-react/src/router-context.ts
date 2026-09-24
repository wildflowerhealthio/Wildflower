import { useRouteContext, useRouter } from '@tanstack/react-router'
import { type Layer } from 'effect'
import { type GatekeeperHttpApiClient } from 'gatekeeper-core/clients'
import { type BaseRouterContext } from 'shared-structures-react'

import { buildGatekeeperClientLayer } from './client/gatekeeper-client.ts'

type RuntimeLayer = BaseRouterContext.RuntimeLayerWith<GatekeeperHttpApiClient>
type RunAuthed = BaseRouterContext.RunAuthedWith<GatekeeperHttpApiClient>

/**
 * Slice-local router-context — `BaseRouterContext.RouterContextWith`
 * narrowed to this slice's client, plus the optional host-threaded
 * `localGrantedScopes` and `firstPartyClientId`. `awaitAuthReady` is inherited
 * only to keep this structural context a faithful subset of the host app's
 * `RouterContext`; gatekeeper loaders don't read it — the gate guarantees the
 * token before the loader runs.
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
  /**
   * The host's first-party OAuth `client_id` (e.g. `wildflower-host`), threaded
   * from the Tauri shell's `tauri-shared-config.json` so the WebView's
   * device-login `client_id` matches the id gatekeeper-rust seeds the first-party
   * client under. Omitted on web/standalone builds, where
   * {@link useGatekeeperFirstPartyClientId} returns `undefined` and the caller
   * falls back to gatekeeper-core's `FIRST_PARTY_CLIENT_ID`.
   */
  readonly firstPartyClientId?: string
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
 * The fully-composed `runtimeLayer` from router context, for the gatekeeper
 * call site that isn't a one-shot Promise and so can't go through
 * `runAuthed`/`useSuspenseQuery`: `NeedsAuthMessage`, whose RFC 8628 device
 * flow runs a long-lived fiber with retry + interrupt-on-unmount. It
 * `Effect.provide`s this layer onto a gatekeeper Effect and runs it
 * imperatively (via `Effect.runFork`). The annotated `select` re-narrows
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

/**
 * The host's first-party OAuth `client_id` from router context (see
 * {@link RouterContext.firstPartyClientId}). `NeedsAuthMessage` identifies its
 * device-login request with this so it matches the id gatekeeper seeds the
 * first-party client under. `undefined` on standalone/web builds where the host
 * context doesn't carry it — the caller falls back to gatekeeper-core's
 * `FIRST_PARTY_CLIENT_ID`.
 */
const useGatekeeperFirstPartyClientId = (): string | undefined =>
  useRouteContext({
    from: '__root__',
    select: (context: RouterContext) => context.firstPartyClientId,
  })

/**
 * The served root of the owner UI copy this slice is mounted in: the page's
 * origin plus the router's basepath, slash-terminated (e.g.
 * `https://wildflowerhealthio.github.io/staging/pr-7/app/`). `NeedsAuthMessage`
 * points its device-flow link here (see gatekeeper-core's
 * `GatekeeperPaths.deviceEntryUrlOn`).
 */
const useGatekeeperServedRoot = (): string => {
  const { basepath } = useRouter()
  return new URL(basepath.endsWith('/') ? basepath : `${basepath}/`, window.location.origin).href
}

export {
  sliceRuntimeLayer,
  useGatekeeperFirstPartyClientId,
  useGatekeeperLocalGrantedScopes,
  useGatekeeperRuntimeLayer,
  useGatekeeperServedRoot,
}
export type { RouterContext, RunAuthed, RuntimeLayer }
