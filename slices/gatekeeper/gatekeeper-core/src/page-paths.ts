// oxlint-disable import/group-exports -- Exports are already namespaced
import type { HttpServerRequest } from '@effect/platform'
import { Effect } from 'effect'
import { type Origin, type UntrustedRemotePeer, requestOriginFromHttpRequest } from 'navigation-core'

/**
 * Single source of truth for the URLs the gatekeeper API redirects to.
 * The SPA router in `gatekeeper-react` declares matching `<Route path>`
 * values; a drift test asserts they agree.
 *
 * @remarks
 * Each route exposes `*Path(...)` (absolute path) and `*Url(...)`
 * (`Effect<string, UntrustedRemotePeer, Origin | HttpServerRequest>` for
 * server-side redirects). Path params are percent-encoded — callers MUST
 * NOT re-encode.
 *
 * The `*Url` helpers derive the origin from
 * `requestOriginFromHttpRequest` so a 302 redirect back to the
 * gatekeeper UI lands on the *same URL the user-agent used to reach
 * `/oauth/authorize`* — required because a redirect to a different
 * origin breaks the in-flight session (cookies, tab, tunnel
 * reachability). That derivation is fail-closed, so the effect can fail
 * with `UntrustedRemotePeer` when a non-loopback peer reaches the
 * endpoint; callers map it to their endpoint's native rejection.
 */
export namespace GatekeeperPaths {
  type PathEffect = Effect.Effect<
    string,
    UntrustedRemotePeer,
    Origin | HttpServerRequest.HttpServerRequest
  >

  const withOrigin = (path: string): PathEffect =>
    Effect.map(requestOriginFromHttpRequest, (origin) => `${origin}${path}`)

  export const oauthPollingPath = (id: string): string =>
    `/gatekeeper/oauth-polling/${encodeURIComponent(id)}`

  export const oauthConsentPath = (id: string): string =>
    `/gatekeeper/oauth-consent/${encodeURIComponent(id)}`

  export const deviceEntryPath = (): string => `/gatekeeper/devices`

  export const deviceConsentPath = (userCode: string): string =>
    `/gatekeeper/devices/${encodeURIComponent(userCode)}`

  export const oauthPollingUrl = (id: string): PathEffect => withOrigin(oauthPollingPath(id))

  export const oauthConsentUrl = (id: string): PathEffect => withOrigin(oauthConsentPath(id))

  export const deviceEntryUrl = (): PathEffect => withOrigin(deviceEntryPath())

  /**
   * Prefilled device-entry URL for RFC 8628's `verification_uri_complete`
   * (§3.3.1) — `/gatekeeper/devices?user_code=…` so the SPA hydrates the
   * form without re-typing.
   */
  export const deviceEntryUrlWithCode = (userCode: string): PathEffect =>
    Effect.map(requestOriginFromHttpRequest, (origin) => {
      const query = new URLSearchParams({ user_code: userCode }).toString()
      return `${origin}${deviceEntryPath()}?${query}`
    })

  export const deviceConsentUrl = (userCode: string): PathEffect =>
    withOrigin(deviceConsentPath(userCode))
}
