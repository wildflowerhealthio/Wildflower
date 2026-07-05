/**
 * The device-login route target, owned by gatekeeper-react (which owns the route
 * file and the auth-ready redirect) so every navigation to it — the auth-ready
 * gate's redirect AND the app's 401-driven redirect — shares one source for the
 * path and the `returnTo` search param. Without this the app hard-codes the pair
 * a second time and a rename silently strands users on a dead route.
 */
const DEVICE_LOGIN_ROUTE = '/gatekeeper/device-login'

/**
 * Build the `{ to, search }` for a redirect/navigate to device login, carrying
 * the originally-requested path as `returnTo` so sign-in returns the user there.
 * Shape accepted by both TanStack's `redirect(...)` and `router.navigate(...)`.
 */
const buildDeviceLoginTarget = (
  returnTo?: string
): { readonly to: typeof DEVICE_LOGIN_ROUTE; readonly search: { readonly returnTo?: string } } => ({
  to: DEVICE_LOGIN_ROUTE,
  search: { returnTo },
})

export { DEVICE_LOGIN_ROUTE, buildDeviceLoginTarget }
