import type { AppsRouterContext } from 'apps-react'
import type { CollectorRouterContext } from 'collector-react'
import type { DatabasesRouterContext } from 'databases-react'
import type { Layer } from 'effect'
import type { FhirR4ResourcesRouterContext } from 'fhir-r4-react'
import type { GatekeeperRouterContext } from 'gatekeeper-react'
import type { BaseRouterContext } from 'shared-structures-react'
import type { TunnelRouterContext } from 'tunnel-react'

import type { ReactTransport } from './bridges/transport-context.ts'

/**
 * The router context threaded through every route in `apps/wildflower-react`:
 * the shared `BaseRouterContext` shape specialised to this app's slice set, plus
 * the host-config fields the embedded Tauri shell supplies. The runtime that
 * populates it lives in `runtime-layer.ts` (`buildRunAuthed`) and
 * `query-client.ts` (`buildQueryClient`); this module only names the shape they
 * satisfy and the route files read.
 */

type SliceServices =
  | Layer.Layer.Success<TunnelRouterContext.RuntimeLayer>
  | Layer.Layer.Success<AppsRouterContext.RuntimeLayer>
  | Layer.Layer.Success<GatekeeperRouterContext.RuntimeLayer>
  | Layer.Layer.Success<CollectorRouterContext.RuntimeLayer>
  | Layer.Layer.Success<FhirR4ResourcesRouterContext.RuntimeLayer>
  | Layer.Layer.Success<DatabasesRouterContext.RuntimeLayer>

type RuntimeLayer = BaseRouterContext.RuntimeLayerWith<SliceServices>
type RunAuthed = BaseRouterContext.RunAuthedWith<SliceServices>

interface RouterContext extends BaseRouterContext.RouterContextWith<SliceServices> {
  /** Which entry point mounted the app — routes use this to vary behavior. */
  readonly entry: 'main-web' | 'main-tauri'
  /**
   * Resolves to the page-side `BridgeTransport` (narrowed to the React
   * surface — only `sendMessage`) once the boot-time `signalReady`
   * finishes. The `_auth` route loader awaits this
   * before emitting the embedded `UIReady` handshake; by the time the
   * loader runs the `beforeLoad` gate's `awaitAuthReady` has already
   * resolved (which on embedded already waited the same promise), so
   * the await is a microtask on every path that reaches here.
   */
  readonly transport: Promise<ReactTransport>
  /**
   * Absolute API origin, set only when the page is not served by the API
   * server (the Tauri webview loads from the dev server / asset protocol while
   * the API lives on the host's loopback origin) — the same value passed to
   * {@link buildAppQueryRuntime}. Threaded into context so the apps launch
   * POST can target the host server rather than the page origin. Omitted on
   * web/embedded, where the page IS the API origin.
   */
  readonly apiBaseUrl?: string
  /**
   * The host's granted-scope string (e.g. `system/*.cruds wildflower/*.cruds`),
   * sourced from the Tauri shell's `tauri-shared-config.json`. Read by the
   * gatekeeper slice's `NeedsAuthMessage` so the WebView's device-login request
   * asks for exactly the scopes gatekeeper-rust seeds. Omitted on web/embedded.
   */
  readonly localGrantedScopes?: string
  /**
   * The host's first-party OAuth `client_id` (e.g. `wildflower-host`), sourced
   * from the Tauri shell's `tauri-shared-config.json`. Read by the gatekeeper
   * slice's `NeedsAuthMessage` so the WebView's device-login `client_id` matches
   * the id gatekeeper-rust seeds the first-party client under. Omitted on
   * web/embedded (the gatekeeper-core `FIRST_PARTY_CLIENT_ID` fallback applies).
   */
  readonly firstPartyClientId?: string
  /**
   * Where a link meant for another device points: this owner UI's address as
   * seen from outside the page, with no trailing slash, to which the router's
   * basepath is appended. Read by the gatekeeper slice's `NeedsAuthMessage` for
   * its device-flow pairing link. `main-web` passes its own origin;
   * `main-tauri`, whose origin no other device can open, passes the hosted
   * owner UI.
   */
  readonly externalLinkRoot: () => string
  /**
   * Why the web entry's boot-time SMART sign-in failed, when it did — the
   * `reason` off a `SignInError`, already written for a reader. `main-web`
   * redeems the authorization code before it mounts the router, so a failed
   * return leg has no tree to render itself into; the landing route shows this
   * instead. Omitted on every other entry and on an ordinary load.
   */
  readonly signInProblem?: string
}

export type { RouterContext, RunAuthed, RuntimeLayer }
