# Browser Pairing

{{#covers apps/host/wildflower-server/authorization-server-rust/tests/integration/browser_pairing.rs}}

A browser that isn't the Owner's gets a browser session by pairing. It opens `/oauth/pair`, whose page starts a pairing (`POST /oauth/pair/start`), shows a code, and polls (`POST /oauth/pair/poll`). The Owner approves that code at the device page, `/authorization/devices/{userCode}`, unticking whatever the browser shouldn't have. The poll that finds the pairing approved hands the browser its approved session as the browser session cookie.

**Pairing is no OAuth flow.** No client redeems it at `/oauth/token`, and it records no grant. What it starts is an approved [browser session](<../Domain/Browser Session Explanation.md>), lasting a day, holding exactly what the Owner approved. The pairing itself is an [authorization request](<../Domain/Authorization Request Explanation.md>) of the pairing kind, driven by {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/browser_pairing.rs BrowserPairing}}. In the running server the host's cookie-to-bearer layer presents the Owner's session token for the device page; these tests send it as the bearer themselves.

## Helpers

`start_pairing` starts a pairing as the page does on load, from a Firefox on Linux user agent. It checks the browser is named from its user agent, the `next` is echoed back, and the pairing lasts 300 seconds with a 5-second poll interval:

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/browser_pairing.rs start_pairing}}

`approved_session_token` reads the session token from the one cookie an approved poll sets, and checks the cookie's attributes, including that it lasts a day:

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/browser_pairing.rs approved_session_token}}

## `a_browser_pairs_and_holds_a_day_long_session_with_the_approved_scopes`

**The whole pairing, end to end.** Starting it makes it the newest pending consent, named for the browser, so the host notifies the Owner. A pending poll sets no cookie and renames the browser to the name the page gives. The device page shows the pairing as a browser, with that name, and opens with all of the Owner's scopes ticked. The Owner approves with two scopes ticked.

The next poll hands the browser a 24-hour token for the browser-session client, holding exactly those two scopes. The stored session is `approved`, named, holds the same scopes and lasts 24 hours. The gates accept the token with exactly its scopes. No grant is recorded. The pairing starts one session only: the poll after that reads `expired`.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/browser_pairing.rs a_browser_pairs_and_holds_a_day_long_session_with_the_approved_scopes}}

Relies on [`stamp_pairing_poll`](<../Domain/Authorization Request Explanation.md#stamp_pairing_poll>), [`approve_pairing`](<../Domain/Authorization Request Explanation.md#approve_pairing>), [`claim`](<../Domain/Authorization Request Explanation.md#claim>), [`new_approved`](<../Domain/Browser Session Explanation.md#new_approved>) and [`NewestPendingConsent`](<../Domain/Pending Consent Explanation.md>).

## `a_declined_pairing_sets_no_cookie`

**A declined pairing tells the page so, and sets no cookie.**

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/browser_pairing.rs a_declined_pairing_sets_no_cookie}}

Relies on [`deny`](<../Domain/Authorization Request Explanation.md#deny>).

## `an_approval_grants_nothing_past_the_owner_s_scopes_or_the_approver_s`

**No browser session holds more than the Owner's scopes, and no approver hands on access it doesn't hold.** Ticks outside the Owner's scopes (`openid`, `offline_access`) are dropped, leaving `wildflower/launch`. An approver holding only the power to read and decide requests, ticking `system/*.cruds`, is refused with `403`, and the pairing stays pending.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/browser_pairing.rs an_approval_grants_nothing_past_the_owner_s_scopes_or_the_approver_s}}

Relies on {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs ApprovableScopes::for_browser_pairing}} and {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs DelegatedScopes::clamp}}.

## `a_narrower_approver_s_card_opens_with_what_it_may_delegate`

**An approver holding less than the Owner sees a card that opens with what it may delegate, not with the Owner's scopes**, so approving the card as it opened succeeds. The card still lists `wildflower/launch` among the scopes the pairing allows, but leaves it unticked for an approver without it, and ticking it is refused with `403`. Approving the opening ticks starts a session holding exactly those three scopes.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/browser_pairing.rs a_narrower_approver_s_card_opens_with_what_it_may_delegate}}

Relies on {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/authority/delegated_scopes.rs ApprovableScopes::delegable_scopes}}.

## `a_foreign_next_or_an_unknown_code_starts_and_finds_nothing`

**A pairing only ever sends the browser back to a path on this server.** A `next` on another origin, a protocol-relative one, a backslash spelling that browsers read as another host, and even the launcher are all `400` `BrowserPairingNextNotAllowed`, and nothing is raised for the Owner. A poll is bound to the pairing code only the page holds: an unknown code, and the user code shown on screen, are both `404` `BrowserPairingNotFound`.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/browser_pairing.rs a_foreign_next_or_an_unknown_code_starts_and_finds_nothing}}

Relies on {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/sign_in_redirect.rs SignInDestinations::allow_on_this_server}}.

## `the_token_endpoint_cannot_mint_a_browser_token`

**`/oauth/token` mints no browser session token**, before or after the Owner approves the pairing. The browser-session client may use no grant type, so a device-code exchange naming it is `unauthorized_client`. A pairing code presented as another client's `device_code` names no device request of that client, so it is `invalid_grant`. The pairing is left approved and unclaimed for its own poll.

{{#code apps/host/wildflower-server/authorization-server-rust/tests/integration/browser_pairing.rs the_token_endpoint_cannot_mint_a_browser_token}}

Relies on the [client](<../Domain/Client Explanation.md>)'s allowed grant types and {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/authority/redemption.rs ConsumedDeviceRequest::consume}}, which finds only device requests of the presenting client.
