import { createFileRoute } from '@tanstack/react-router'

import { NeedsAuthMessage } from '../../../components/NeedsAuthMessage.tsx'

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
 */
export const Route = createFileRoute('/_open/gatekeeper/device-login')({
  component: NeedsAuthMessage,
})
