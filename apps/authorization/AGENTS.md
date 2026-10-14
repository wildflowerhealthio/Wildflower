# AGENTS.md — apps/authorization

**Wildflower Authorization**, published at `/authorization/`: where the Owner
manages what a Wildflower server has authorized. It is a SMART client of the
server `?iss=` names, and every Wildflower server advertises it, pointed at
itself, as its SMART `management_endpoint`
(`wildflowerhealthio_shared_structures::authorization_app`). Approving
requests is not here: the launcher's approval routes still do that.

## Packages

- `authorization-web` — the app. Its queries, its Trusted Apps section and
  the API client come from the shared `slices/authorization` packages
  (`authorization-react`, `authorization-core`), which the launcher's
  approval routes also use.

## Guardrails

- **The server is `?iss=`.** Every way in carries it: a server's
  `management_endpoint`, the launcher's Manage access row
  (`launcher-web`'s `session/manage-access-settings-item.ts`), and a pick from
  the shared `ConnectMenu` (`target="wildflower"`), which sets it. The
  signed-in router keeps it on every navigation
  (`retainSearchParams`), so a reload or a bookmark signs back in to the same
  server.
- **Configured from discovery.** `src/sign-in.ts` reads the server's SMART
  configuration (`authorization-core/smart-client`'s
  `discoverSmartEndpoints`) before a sign-in starts and again once it is
  redeemed. A document without the `wildflower-server` capability gets "This
  isn't a Wildflower server" and no sign-in. The API's requests go to the
  `wildflower_authorization_api` it advertises
  (`src/router-context.ts`'s `apiRequestBaseUrl`).
- **The bearer lives in page memory.** The sign-in is the SMART standalone
  launch with PKCE (`authorization-core/smart-client`), as the launcher's is,
  under the app's own client (`src/config.ts`, seeded by the authorization
  server migration `0031_seed_authorization_web_client`) and its own
  `sessionStorage` key for the pending record, which holds no credential. The
  redeemed token is held by the signed-in tree alone; a reload signs in
  again.
- **The client's scopes are pinned.** `AUTHORIZATION_SCOPE` in
  `src/config.ts` and the seeded row's `allowed_scopes` must match, element
  for element: `authorization-server-rust`'s `db/clients.rs` reads the file and
  fails otherwise.
- **Essential clients can't be disabled.** The Trusted Apps section offers
  the host app's client and the Owner-browser client no switch (the server
  answers `409 EssentialClient`).
- **No Revoke on this app's own grant.** The Approved Apps list offers none
  there, since it would revoke the page's bearer.
- **Revoking a grant is two calls**: `DELETE /authorization/grants/:id`, then
  `POST /authorization/revocations` for the grant's client
  (`authorization-react`'s `useRevokeGrantMutation`).
- **Nothing boots before the telemetry consent dialog is answered.**
  `src/app-root.tsx`'s `ConsentedEntryRoot` runs the boot (the sign-in
  redemption) only after an answer, reporting to `VITE_SENTRY_DSN_AUTHORIZATION_WEB`
  tagged `app: authorization-web`.

## References

- [apps/AGENTS.md](../AGENTS.md) — product folders and the names a product takes
- [slices/authorization/AGENTS.md](../../slices/authorization/AGENTS.md) — the shared authorization packages
- [slices/branding/AGENTS.md](../../slices/branding/AGENTS.md) — the 404 redirect and the landing page
