// Single source of truth for the URLs the gatekeeper API redirects to. The
// SPA router in gatekeeper-web declares matching <Route path> values for each
// entry; a drift test asserts they cannot disagree. Path params are
// percent-encoded for path-segment use, so callers MUST NOT
// `encodeURIComponent` again at the call site.
const GatekeeperPaths = {
  oauthPolling: (id: string): string => `/gatekeeper/oauth-polling/${encodeURIComponent(id)}`,
  oauthConsent: (id: string): string => `/gatekeeper/oauth-consent/${encodeURIComponent(id)}`,
  deviceEntry: (): string => `/gatekeeper/devices`,
  deviceConsent: (userCode: string): string =>
    `/gatekeeper/devices/${encodeURIComponent(userCode)}`,
} as const

export { GatekeeperPaths }
