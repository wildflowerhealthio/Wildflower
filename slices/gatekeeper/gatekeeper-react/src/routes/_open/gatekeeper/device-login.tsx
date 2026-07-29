import { createFileRoute } from '@tanstack/react-router'

import { NeedsAuthMessage } from '../../../components/NeedsAuthMessage.tsx'
import type { DeviceLoginSearch } from '../../../device-login-route.ts'

/**
 * Public device-login route — the redirect target the `_auth` /
 * `/settings` `beforeLoad` gate sends standalone web to when no bearer
 * token is present. Renders {@link NeedsAuthMessage}, which runs the
 * RFC 8628 device-authorization flow: surface a `user_code`, poll
 * `/oauth/token` until a signed-in device approves, then write the
 * issued bearer through `authTokenRef`.
 *
 * Lives under the public `_open` layout (no auth gate) so the gate's
 * redirect doesn't loop. Sits beside the other gatekeeper OAuth /
 * device-flow screens (`devices`, `oauth-polling`) — same RFC 8628
 * surface, conventional placement.
 *
 * `validateSearch` declares the optional `returnTo` the auth gate's
 * `redirect(...)` rides (the originally-requested same-origin path) and
 * the optional `requestScopes` the 403 step-up action rides (the scopes
 * to pre-fill the picker with), so both search params type-check
 * against the registered router and survive the redirect. Non-string
 * values are dropped; the raw values are interpreted at the point of
 * use by `NeedsAuthMessage` (`sanitizeReturnTo` closes the
 * open-redirect hole, `parseRequestScopes` decodes the scope list), so
 * no further guard is needed here.
 */
export const Route = createFileRoute('/_open/gatekeeper/device-login')({
  component: NeedsAuthMessage,
  validateSearch: (search: Record<string, unknown>): DeviceLoginSearch => {
    const returnTo = search['returnTo']
    const requestScopes = search['requestScopes']
    return {
      ...(typeof returnTo === 'string' ? { returnTo } : {}),
      ...(typeof requestScopes === 'string' ? { requestScopes } : {}),
    }
  },
})
