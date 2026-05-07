import { Effect } from 'effect'
import { Origin } from 'kitchen-sink'

// Single source of truth for the URLs the gatekeeper API redirects to. The
// SPA router in gatekeeper-react declares matching <Route path> values for each
// entry; a drift test asserts they cannot disagree.
//
// Each route exposes a pair:
// - `*Path(...)` — the absolute path string (`/gatekeeper/...`), suitable
//   for `<Route path>` literals and for places that already hold an
//   origin to concatenate with.
// - `*Url(...)` — an `Effect<string, never, Origin>` that resolves the
//   `Origin` Tag and returns the full URL. Use this on the server side
//   (token-exchange responses, redirects) so the origin source is the
//   kitchen-sink `Origin` Tag, not a parameter passed by every caller.
//   The pairing makes "I forgot a slash" or "I built the URL by hand"
//   harder to write.
//
// Path params are percent-encoded for path-segment use, so callers MUST NOT
// `encodeURIComponent` again at the call site.
//
// Imported as `import * as GatekeeperPaths from 'gatekeeper-core/page-paths'`.

const oauthPollingPath = (id: string): string =>
  `/gatekeeper/oauth-polling/${encodeURIComponent(id)}`

const oauthConsentPath = (id: string): string =>
  `/gatekeeper/oauth-consent/${encodeURIComponent(id)}`

const deviceEntryPath = (): string => `/gatekeeper/devices`

const deviceConsentPath = (userCode: string): string =>
  `/gatekeeper/devices/${encodeURIComponent(userCode)}`

const withOrigin = (path: string): Effect.Effect<string, never, Origin> =>
  Effect.map(Origin, (origin) => `${origin}${path}`)

const oauthPollingUrl = (id: string): Effect.Effect<string, never, Origin> =>
  withOrigin(oauthPollingPath(id))

const oauthConsentUrl = (id: string): Effect.Effect<string, never, Origin> =>
  withOrigin(oauthConsentPath(id))

const deviceEntryUrl = (): Effect.Effect<string, never, Origin> => withOrigin(deviceEntryPath())

// Prefilled variant of the device-entry page, used to populate RFC 8628's
// `verification_uri_complete` (§3.3.1) — the same `/gatekeeper/devices`
// route, but with `?user_code=` appended so the SPA can hydrate the form
// without the user re-typing the code. Built with `URLSearchParams` so
// any future change to `userCode`'s character class encodes correctly.
const deviceEntryUrlWithCode = (userCode: string): Effect.Effect<string, never, Origin> =>
  Effect.map(Origin, (origin) => {
    const query = new URLSearchParams({ user_code: userCode }).toString()
    return `${origin}${deviceEntryPath()}?${query}`
  })

const deviceConsentUrl = (userCode: string): Effect.Effect<string, never, Origin> =>
  withOrigin(deviceConsentPath(userCode))

export {
  oauthPollingPath,
  oauthConsentPath,
  deviceEntryPath,
  deviceConsentPath,
  oauthPollingUrl,
  oauthConsentUrl,
  deviceEntryUrl,
  deviceEntryUrlWithCode,
  deviceConsentUrl,
}
