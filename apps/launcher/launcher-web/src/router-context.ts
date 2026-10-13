import type { AppsRouterContext } from '@wildflowerhealthio/apps-react'
import type { AuthorizationRouterContext } from '@wildflowerhealthio/authorization-react'
import type { DatabasesRouterContext } from '@wildflowerhealthio/databases-react'
import type { FhirR4ResourcesRouterContext } from '@wildflowerhealthio/fhir-r4-react'
import type { RequestLogRouterContext } from '@wildflowerhealthio/request-log-react'
import type { BaseRouterContext } from '@wildflowerhealthio/shared-structures-react'
import type { Layer } from 'effect'

import type { ServerKind } from './session/server-kind.ts'
import type { SignInProblem, UnsentEhrLaunch } from './sign-in.ts'

/**
 * The router context threaded through every route in `apps/launcher/launcher-web`:
 * the shared `BaseRouterContext` shape specialised to this app's slice set, plus
 * what this page load knows about its sign-in. The runtime that
 * populates it lives in `runtime-layer.ts` (`buildRunAuthed`) and
 * `query-client.ts` (`buildQueryClient`); this module only names the shape they
 * satisfy and the route files read.
 */

type SliceServices =
  | Layer.Layer.Success<AppsRouterContext.RuntimeLayer>
  | Layer.Layer.Success<AuthorizationRouterContext.RuntimeLayer>
  | Layer.Layer.Success<FhirR4ResourcesRouterContext.RuntimeLayer>
  | Layer.Layer.Success<DatabasesRouterContext.RuntimeLayer>
  | Layer.Layer.Success<RequestLogRouterContext.RuntimeLayer>

type RuntimeLayer = BaseRouterContext.RuntimeLayerWith<SliceServices>
type RunAuthed = BaseRouterContext.RunAuthedWith<SliceServices>

interface RouterContext extends BaseRouterContext.RouterContextWith<SliceServices> {
  /**
   * Where a link meant for another device points: this launcher's address as
   * seen from outside the page, with no trailing slash, to which the router's
   * basepath is appended. Read by the authorization slice's `NeedsAuthMessage` for
   * its device-flow pairing link. `main-web` passes its own origin.
   */
  readonly externalLinkRoot: () => string
  /**
   * Why the boot-time SMART sign-in failed, when it did — the `reason` off a
   * `SignInError`, already written for a reader, and the server the failed
   * sign-in was to. `main-web` redeems the authorization code before it mounts
   * the router, so a failed return leg has no tree to render itself into; the
   * landing route shows this instead. Omitted on an ordinary load.
   */
  readonly signInProblem?: SignInProblem
  /**
   * The SMART EHR launch the page load was opened with, until a sign-in takes
   * it. `main-web` takes it out of the URL before it mounts the router and
   * holds it here, once per page load, so the landing route signs in to its
   * server with it on arrival, and a landing that mounts again does not offer
   * it a second time. Omitted on a load that carried none.
   */
  readonly ehrLaunch?: UnsentEhrLaunch
  /**
   * Which kind of server this tree was built for. The auth-gated routes read
   * it to send a reader to the routes that kind serves
   * (`session/auth-gated-route-options.ts`), and the plain SMART Home reads
   * its FHIR base. See `RenderAppOptions.serverKind`.
   */
  readonly serverKind: ServerKind
}

export type { RouterContext, RunAuthed, RuntimeLayer }
