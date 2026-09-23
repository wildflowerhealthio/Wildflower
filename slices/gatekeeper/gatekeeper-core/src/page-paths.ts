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
  export const oauthPollingPath = (id: string): string =>
    `/gatekeeper/oauth-polling/${encodeURIComponent(id)}`

  export const oauthConsentPath = (id: string): string =>
    `/gatekeeper/oauth-consent/${encodeURIComponent(id)}`

  export const deviceEntryPath = (): string => `/gatekeeper/devices`

  export const deviceConsentPath = (userCode: string): string =>
    `/gatekeeper/devices/${encodeURIComponent(userCode)}`
}
