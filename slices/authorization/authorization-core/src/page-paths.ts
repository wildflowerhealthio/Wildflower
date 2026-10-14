// oxlint-disable import/group-exports -- Exports are already namespaced
/**
 * Single source of truth for the launcher routes of the authorization server's
 * browser-facing pages. The SPA router in `authorization-react` declares matching
 * `<Route path>` values; a drift test asserts they agree.
 *
 * @remarks
 * Each is a launcher-relative path; path params are percent-encoded — callers
 * MUST NOT re-encode. The absolute URLs a server hands a browser are built on
 * the Rust side (`authorization-server-rust`'s `domain/page_paths.rs`): the hosted
 * launcher's base plus this path, with `?server=<served origin>` naming the server
 * the page should talk back to.
 */
export namespace AuthorizationServerPaths {
  export const oauthConsentPath = (id: string): string =>
    `/authorization/oauth-consent/${encodeURIComponent(id)}`

  export const deviceEntryPath = (): string => `/authorization/devices`

  export const deviceConsentPath = (userCode: string): string =>
    `/authorization/devices/${encodeURIComponent(userCode)}`
}
