import { useRouteContext, useRouter } from '@tanstack/react-router'
import { type AuthorizationServerHttpApiClient } from '@wildflowerhealthio/authorization-core/clients'
import { type BaseRouterContext } from '@wildflowerhealthio/shared-structures-react'
import { type Layer } from 'effect'

import { buildAuthorizationServerClientLayer } from './client/authorization-server-client.ts'

type RuntimeLayer = BaseRouterContext.RuntimeLayerWith<AuthorizationServerHttpApiClient>
type RunAuthed = BaseRouterContext.RunAuthedWith<AuthorizationServerHttpApiClient>

/**
 * Slice-local router-context — `BaseRouterContext.RouterContextWith`
 * narrowed to this slice's client, plus the host-threaded
 * `localGrantedScopes`, `firstPartyClientId` and `externalLinkRoot`. `awaitAuthReady` is inherited
 * only to keep this structural context a faithful subset of the host app's
 * `RouterContext`; the authorization server loaders don't read it — the gate guarantees the
 * token before the loader runs.
 */
type RouterContext = BaseRouterContext.RouterContextWith<AuthorizationServerHttpApiClient> & {
  /**
   * The host's granted-scope string (e.g. `system/*.cruds wildflower/*.cruds`),
   * threaded from the Tauri shell's `tauri-shared-config.json` so the WebView's
   * device-login request asks for exactly the scopes authorization-server-rust seeds for
   * the first-party client. Omitted on web/standalone builds, where
   * {@link useAuthorizationLocalGrantedScopes} returns `undefined` and the caller
   * falls back to the canonical default.
   */
  readonly localGrantedScopes?: string
  /**
   * The host's first-party OAuth `client_id` (e.g. `wildflower-host`), threaded
   * from the Tauri shell's `tauri-shared-config.json` so the WebView's
   * device-login `client_id` matches the id authorization-server-rust seeds the first-party
   * client under. Omitted on web/standalone builds, where
   * {@link useAuthorizationFirstPartyClientId} returns `undefined` and the caller
   * falls back to authorization-core's `FIRST_PARTY_CLIENT_ID`.
   */
  readonly firstPartyClientId?: string
  /**
   * Where a link meant for another device points: this launcher's address as
   * seen from outside the page, with no trailing slash, to which the router's
   * basepath is appended. The launcher passes its own origin. Read through
   * {@link useAuthorizationExternalRoot}.
   */
  readonly externalLinkRoot: () => string
}

/**
 * The authorization server slice's client layer, ready for the app to merge into
 * its composed `runtimeLayer` over `BaseRouterContext.RuntimeLayer`
 * (`HttpClient`). Tokenless — see {@link buildAuthorizationServerClientLayer}.
 */
const sliceRuntimeLayer: Layer.Layer<
  AuthorizationServerHttpApiClient,
  never,
  Layer.Layer.Success<BaseRouterContext.RuntimeLayer>
> = buildAuthorizationServerClientLayer()

/**
 * The fully-composed `runtimeLayer` from router context, for the authorization server
 * call site that isn't a one-shot Promise and so can't go through
 * `runAuthed`/`useSuspenseQuery`: `NeedsAuthMessage`, whose RFC 8628 device
 * flow runs a long-lived fiber with retry + interrupt-on-unmount. It
 * `Effect.provide`s this layer onto an authorization server Effect and runs it
 * imperatively (via `Effect.runFork`). The annotated `select` re-narrows
 * the result when the slice's router isn't registered (standalone build),
 * where `useRouteContext()` would otherwise widen to `any` — no cast.
 */
const useAuthorizationRuntimeLayer = (): RuntimeLayer =>
  useRouteContext({ from: '__root__', select: (context: RouterContext) => context.runtimeLayer })

/**
 * The host's granted-scope string from router context (see
 * {@link RouterContext.localGrantedScopes}). `NeedsAuthMessage` requests exactly
 * this set at device login so it matches the first-party client's seeded
 * `allowed_scopes`. `undefined` on standalone/web builds where the host context
 * doesn't carry it — the caller falls back to the canonical default.
 */
const useAuthorizationLocalGrantedScopes = (): string | undefined =>
  useRouteContext({
    from: '__root__',
    select: (context: RouterContext) => context.localGrantedScopes,
  })

/**
 * The host's first-party OAuth `client_id` from router context (see
 * {@link RouterContext.firstPartyClientId}). `NeedsAuthMessage` identifies its
 * device-login request with this so it matches the id the authorization server seeds the
 * first-party client under. `undefined` on standalone/web builds where the host
 * context doesn't carry it — the caller falls back to authorization-core's
 * `FIRST_PARTY_CLIENT_ID`.
 */
const useAuthorizationFirstPartyClientId = (): string | undefined =>
  useRouteContext({
    from: '__root__',
    select: (context: RouterContext) => context.firstPartyClientId,
  })

/**
 * The address another device reaches this launcher's routes at: the host's
 * {@link RouterContext.externalLinkRoot} plus the router's basepath,
 * slash-terminated (e.g. `https://wildflowerhealthio.github.io/staging/pr-7/launcher/`
 * on a PR preview, `https://wildflowerhealth.io/launcher/` on the hosted build).
 * `NeedsAuthMessage` points its device-flow link here (see authorization-core's
 * `AuthorizationServerPaths.deviceEntryUrlOn`).
 */
const useAuthorizationExternalRoot = (): string => {
  const { basepath } = useRouter()
  const externalLinkRoot = useRouteContext({
    from: '__root__',
    select: (context: RouterContext) => context.externalLinkRoot,
  })
  return `${externalLinkRoot()}${basepath.endsWith('/') ? basepath : `${basepath}/`}`
}

export {
  sliceRuntimeLayer,
  useAuthorizationExternalRoot,
  useAuthorizationFirstPartyClientId,
  useAuthorizationLocalGrantedScopes,
  useAuthorizationRuntimeLayer,
}
export type { RouterContext, RunAuthed, RuntimeLayer }
