// oxlint-disable import/group-exports -- Exports are already namespaced
/**
 * Single source of truth for the owner-UI routes of the gatekeeper's
 * browser-facing pages. The SPA router in `gatekeeper-react` declares matching
 * `<Route path>` values; a drift test asserts they agree.
 *
 * @remarks
 * Each is an owner-UI-relative path; path params are percent-encoded — callers
 * MUST NOT re-encode. The absolute URLs a server hands a browser are built on
 * the Rust side (`gatekeeper-rust`'s `domain/page_paths.rs`): the hosted owner
 * UI's base plus this path, with `?server=<served origin>` naming the server
 * the page should talk back to.
 */
export namespace GatekeeperPaths {
  export const oauthConsentPath = (id: string): string =>
    `/gatekeeper/oauth-consent/${encodeURIComponent(id)}`

  export const deviceEntryPath = (): string => `/gatekeeper/devices`

  /**
   * The device-entry page a server's `verification_uri` (or
   * `verification_uri_complete`) names, moved onto the owner UI copy served at
   * `servedRoot` — keeping the query the server built: `?server=` naming the
   * origin it was reached at, and `user_code` on the complete form. The server
   * builds its URIs on the owner UI it is configured with; a copy of the owner
   * UI showing a pairing it started itself (a PR preview, a dev server) links to
   * its own device-entry page instead, so the pairing is approved on the same
   * copy. The server is not asked to trust any address for this.
   *
   * `servedRoot` is slash-terminated (the copy's origin plus its basepath).
   * Throws a `TypeError` when `verificationUri` is not an absolute URL.
   *
   * @example GatekeeperPaths.deviceEntryUrlOn('https://x.test/pr-7/app/', 'https://wildflowerhealth.io/app/gatekeeper/devices?server=s&user_code=AB') // 'https://x.test/pr-7/app/gatekeeper/devices?server=s&user_code=AB'
   */
  export const deviceEntryUrlOn = (servedRoot: string, verificationUri: string): string => {
    const page = new URL(deviceEntryPath().replace(/^\//, ''), servedRoot)
    page.search = new URL(verificationUri).search
    return page.href
  }

  export const deviceConsentPath = (userCode: string): string =>
    `/gatekeeper/devices/${encodeURIComponent(userCode)}`
}
