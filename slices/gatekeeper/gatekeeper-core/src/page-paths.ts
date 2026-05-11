import { Effect } from 'effect'
import { Origin } from 'navigation-core'

/**
 * Single source of truth for the URLs the gatekeeper API redirects to.
 * The SPA router in `gatekeeper-react` declares matching `<Route path>`
 * values; a drift test asserts they agree.
 *
 * @remarks
 * Each route exposes `*Path(...)` (absolute path) and `*Url(...)`
 * (`Effect<string, never, Origin>` for server-side redirects).
 * Path params are percent-encoded — callers MUST NOT re-encode.
 */
export namespace GatekeeperPaths {
  const withOrigin = (path: string): Effect.Effect<string, never, Origin> =>
    Effect.map(Origin, (origin) => `${origin}${path}`)

  export const oauthPollingPath = (id: string): string =>
    `/gatekeeper/oauth-polling/${encodeURIComponent(id)}`

  export const oauthConsentPath = (id: string): string =>
    `/gatekeeper/oauth-consent/${encodeURIComponent(id)}`

  export const deviceEntryPath = (): string => `/gatekeeper/devices`

  export const deviceConsentPath = (userCode: string): string =>
    `/gatekeeper/devices/${encodeURIComponent(userCode)}`

  export const oauthPollingUrl = (id: string): Effect.Effect<string, never, Origin> =>
    withOrigin(oauthPollingPath(id))

  export const oauthConsentUrl = (id: string): Effect.Effect<string, never, Origin> =>
    withOrigin(oauthConsentPath(id))

  export const deviceEntryUrl = (): Effect.Effect<string, never, Origin> =>
    withOrigin(deviceEntryPath())

  /**
   * Prefilled device-entry URL for RFC 8628's `verification_uri_complete`
   * (§3.3.1) — `/gatekeeper/devices?user_code=…` so the SPA hydrates the
   * form without re-typing.
   */
  export const deviceEntryUrlWithCode = (userCode: string): Effect.Effect<string, never, Origin> =>
    Effect.map(Origin, (origin) => {
      const query = new URLSearchParams({ user_code: userCode }).toString()
      return `${origin}${deviceEntryPath()}?${query}`
    })

  export const deviceConsentUrl = (userCode: string): Effect.Effect<string, never, Origin> =>
    withOrigin(deviceConsentPath(userCode))
}
