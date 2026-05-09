import { Effect } from 'effect'
import { Origin } from 'kitchen-sink'

/**
 * Single source of truth for the URLs the gatekeeper API redirects to.
 * The SPA router in `gatekeeper-react` declares matching `<Route path>`
 * values for each entry; a drift test asserts they cannot disagree.
 *
 * Each route exposes a pair:
 * - `*Path(...)` — the absolute path string (`/gatekeeper/...`),
 *   suitable for `<Route path>` literals and for callers that already
 *   hold an origin to concatenate with.
 * - `*Url(...)` — an `Effect<string, never, Origin>` that resolves the
 *   `Origin` Tag and returns the full URL. Use this on the server side
 *   (token-exchange responses, redirects) so the origin source is the
 *   kitchen-sink `Origin` Tag, not a parameter passed by every caller.
 *
 * Path params are percent-encoded for path-segment use, so callers MUST
 * NOT `encodeURIComponent` again at the call site.
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
   * Prefilled variant of the device-entry page, used to populate
   * RFC 8628's `verification_uri_complete` (§3.3.1) — the same
   * `/gatekeeper/devices` route, but with `?user_code=` appended so the
   * SPA can hydrate the form without the user re-typing the code.
   * Built with `URLSearchParams` so any future change to `userCode`'s
   * character class encodes correctly.
   */
  export const deviceEntryUrlWithCode = (
    userCode: string
  ): Effect.Effect<string, never, Origin> =>
    Effect.map(Origin, (origin) => {
      const query = new URLSearchParams({ user_code: userCode }).toString()
      return `${origin}${deviceEntryPath()}?${query}`
    })

  export const deviceConsentUrl = (userCode: string): Effect.Effect<string, never, Origin> =>
    withOrigin(deviceConsentPath(userCode))
}
