// oxlint-disable import/group-exports -- Exports are already namespaced
/**
 * Single source of truth for the launcher routes of the authorization server's
 * browser-facing pages. The SPA router in `authorization-react` declares matching
 * `<Route path>` values; a drift test asserts they agree.
 *
 * @remarks
 * Each is a launcher-relative path; path params are percent-encoded — callers
 * MUST NOT re-encode.
 */
export namespace AuthorizationServerPaths {
  export const oauthConsentPath = (id: string): string =>
    `/authorization/oauth-consent/${encodeURIComponent(id)}`

  export const deviceEntryPath = (): string => `/authorization/devices`

  export const deviceConsentPath = (userCode: string): string =>
    `/authorization/devices/${encodeURIComponent(userCode)}`
}
