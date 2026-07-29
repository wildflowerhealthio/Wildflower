/**
 * The device-login route target, owned by gatekeeper-react (which owns the route
 * file and the auth-ready redirect) so every navigation to it — the auth-ready
 * gate's redirect, the app's 401-driven redirect, AND the 403 step-up action —
 * shares one source for the path and its search params. Without this the app
 * hard-codes the pair a second time and a rename silently strands users on a
 * dead route.
 */
const DEVICE_LOGIN_ROUTE = '/gatekeeper/device-login'

/**
 * The device-login screen's search params.
 *
 * - `returnTo` — the originally-requested same-origin path, so sign-in returns
 *   the user there. Attacker-controllable; sanitized at the point of use by
 *   `NeedsAuthMessage`'s `sanitizeReturnTo`.
 * - `requestScopes` — a space-separated scope list to **pre-fill** the screen's
 *   scope picker with (the OAuth `scope` wire form). Carried by the step-up
 *   flow: a `403 InsufficientScope` names the scopes the caller lacks, and
 *   {@link buildStepUpTarget} threads them here so the device request starts
 *   from exactly what was missing instead of the generic preset.
 */
interface DeviceLoginSearch {
  readonly returnTo?: string
  readonly requestScopes?: string
}

/** A `{ to, search }` pair accepted by both TanStack's `redirect(...)` and `router.navigate(...)`. */
interface DeviceLoginTarget {
  readonly to: typeof DEVICE_LOGIN_ROUTE
  readonly search: DeviceLoginSearch
}

/**
 * Render a scope list into the `requestScopes` wire form: whitespace-separated,
 * de-duplicated, empties dropped. Input tokens are themselves re-split on
 * whitespace, so serializing is idempotent under the encoding and
 * {@link parseRequestScopes} round-trips *any* input — a scope string can't
 * smuggle a separator past the encoding.
 */
const serializeRequestScopes = (scopes: readonly string[]): string =>
  [...new Set(scopes.flatMap((scope) => scope.split(/\s+/)).filter((scope) => scope !== ''))].join(
    ' '
  )

/**
 * Read a `requestScopes` value back into a scope list — the inverse of
 * {@link serializeRequestScopes}. Total: a missing, empty, or all-whitespace
 * value yields no scopes, so a caller can always treat the result as "the
 * pre-filled request, possibly empty".
 */
const parseRequestScopes = (raw: string | undefined | null): readonly string[] =>
  raw === undefined || raw === null
    ? []
    : [...new Set(raw.split(/\s+/).filter((scope) => scope !== ''))]

/**
 * Build the `{ to, search }` for a redirect/navigate to device login, carrying
 * the originally-requested path as `returnTo` so sign-in returns the user there.
 */
const buildDeviceLoginTarget = (returnTo?: string): DeviceLoginTarget => ({
  to: DEVICE_LOGIN_ROUTE,
  search: { returnTo },
})

/**
 * The **step-up** target (resource-authorization epic child ⑤): device login with
 * the scope picker pre-filled with `missingScopes` — the scopes a
 * `403 InsufficientScope` said the caller lacks — and `returnTo` set to where the
 * denial happened, so a granted request lands the user back on the original page
 * (whose loader then re-runs the action against the new grant).
 *
 * An empty `missingScopes` omits the param entirely, collapsing to a plain
 * {@link buildDeviceLoginTarget}: there is nothing to pre-fill, so the screen
 * falls back to its own preset seed rather than showing an empty request.
 */
const buildStepUpTarget = (
  missingScopes: readonly string[],
  returnTo?: string
): DeviceLoginTarget => {
  const requestScopes = serializeRequestScopes(missingScopes)
  const base = buildDeviceLoginTarget(returnTo)
  return requestScopes === '' ? base : { ...base, search: { ...base.search, requestScopes } }
}

/**
 * Read {@link DeviceLoginSearch} out of a raw query string (`window.location.search`),
 * so the route's `validateSearch` and the screen's own mount-time reads share one
 * source for the param names. Values come back raw — `returnTo` is sanitized at
 * the point of use, `requestScopes` is decoded with {@link parseRequestScopes}.
 */
const parseDeviceLoginSearch = (rawQuery: string): DeviceLoginSearch => {
  const params = new URLSearchParams(rawQuery)
  const returnTo = params.get('returnTo')
  const requestScopes = params.get('requestScopes')
  return {
    ...(returnTo === null ? {} : { returnTo }),
    ...(requestScopes === null ? {} : { requestScopes }),
  }
}

export {
  buildDeviceLoginTarget,
  buildStepUpTarget,
  DEVICE_LOGIN_ROUTE,
  parseDeviceLoginSearch,
  parseRequestScopes,
  serializeRequestScopes,
}
export type { DeviceLoginSearch, DeviceLoginTarget }
