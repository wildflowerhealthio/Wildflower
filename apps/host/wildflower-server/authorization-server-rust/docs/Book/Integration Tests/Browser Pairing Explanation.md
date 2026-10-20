# Browser Pairing

{{#covers apps/host/wildflower-server/authorization-server-rust/tests/integration/browser_pairing.rs}}

A browser that isn't the Owner's gets a browser session by pairing. It opens `/oauth/pair`, whose page starts a pairing (`POST /oauth/pair/start`), shows a code, and polls (`POST /oauth/pair/poll`). The Owner approves that code at the [Device Page](<Device Page Explanation.md>)'s API, `/authorization/devices/{userCode}`, unticking whatever the browser shouldn't have. The poll that finds the pairing approved hands the browser its paired session as the browser session cookie.

**Pairing is no OAuth flow.** No client redeems it at `/oauth/token`, and it records no grant. What it starts is a paired [browser session](<../Domain/Browser Session Explanation.md>), lasting a day, holding exactly what the Owner approved. The pairing itself is a [`PairingRequest`](<../Domain/Authorization Request/Polled Requests Explanation.md#item-PairingRequest>), driven by [`BrowserPairing`](<../Capabilities/OAuth/Browser Pairing Explanation.md#item-BrowserPairing>).

This file's own helpers are on the [Test Fixtures](<Test Fixtures Explanation.md#integrationbrowser_pairing>) page, with the shared ones.

## `integration::browser_pairing`

### `a_browser_pairs_and_holds_a_day_long_session_with_the_approved_scopes`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/browser_pairing.rs a_browser_pairs_and_holds_a_day_long_session_with_the_approved_scopes}}

Relies on [`PairingRequest::stamp_poll`](<../Domain/Authorization Request/Polled Requests Explanation.md#item-PairingRequest--stamp_poll>), [`PairingRequest::approve`](<../Domain/Authorization Request/Polled Requests Explanation.md#item-PairingRequest--approve>), [`PairingRequest::claim`](<../Domain/Authorization Request/Polled Requests Explanation.md#item-PairingRequest--claim>), [`BrowserSession::new_paired_session`](<../Domain/Browser Session Explanation.md#item-BrowserSession--new_paired_session>) and [`OwnerPrompt`](<../Domain/Owner Prompt Explanation.md#item-OwnerPrompt>). Fixtures first used here: [`spin_up`](<Test Fixtures Explanation.md#item-spin_up>), [`start_pairing`](<Test Fixtures Explanation.md#item-browser_pairing--start_pairing>), [`owner_prompt`](<Test Fixtures Explanation.md#item-owner_prompt>), [`poll_status`](<Test Fixtures Explanation.md#item-poll_status>), [`signed_in_same_device_session_token`](<Test Fixtures Explanation.md#item-signed_in_same_device_session_token>), [`build_request`](<Test Fixtures Explanation.md#item-build_request>), [`body_json`](<Test Fixtures Explanation.md#item-body_json>), [`approve`](<Test Fixtures Explanation.md#item-approve>), [`paired_session_token`](<Test Fixtures Explanation.md#item-paired_session_token>), [`decode_jwt_payload`](<Test Fixtures Explanation.md#item-decode_jwt_payload>) and [`store_handle`](<Test Fixtures Explanation.md#item-store_handle>).

### `an_approval_grants_nothing_past_the_owner_s_scopes_or_the_approver_s`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/browser_pairing.rs an_approval_grants_nothing_past_the_owner_s_scopes_or_the_approver_s}}

Relies on [`ApprovableScopes::for_browser_pairing`](<../Authority/Delegated Scopes Explanation.md#item-ApprovableScopes--for_browser_pairing>) and [`DelegatedScopes::clamp`](<../Authority/Delegated Scopes Explanation.md#item-DelegatedScopes--clamp>). Fixtures first used here: [`mint_browser_session_token`](<Test Fixtures Explanation.md#item-mint_browser_session_token>).

### `a_narrower_approver_s_card_opens_with_what_it_may_delegate`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/browser_pairing.rs a_narrower_approver_s_card_opens_with_what_it_may_delegate}}

Relies on [`ApprovableScopes::delegable_scopes`](<../Authority/Delegated Scopes Explanation.md#item-ApprovableScopes--delegable_scopes>).

### `a_declined_pairing_sets_no_cookie`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/browser_pairing.rs a_declined_pairing_sets_no_cookie}}

Relies on [`PairingRequest::deny`](<../Domain/Authorization Request/Polled Requests Explanation.md#item-PairingRequest--deny>). Fixtures first used here: [`post_json`](<Test Fixtures Explanation.md#item-post_json>).

### `a_foreign_next_or_an_unknown_code_starts_and_finds_nothing`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/browser_pairing.rs a_foreign_next_or_an_unknown_code_starts_and_finds_nothing}}

Relies on [`SignInDestinations::allow_on_this_server`](<../Domain/Same Device Sign In Codes Explanation.md#item-SignInDestinations--allow_on_this_server>). Fixtures first used here: [`poll`](<Test Fixtures Explanation.md#item-browser_pairing--poll>).

### `the_token_endpoint_cannot_mint_a_browser_token`

{{#item apps/host/wildflower-server/authorization-server-rust/tests/integration/browser_pairing.rs the_token_endpoint_cannot_mint_a_browser_token}}

Relies on [`AllowedGrantType`](<../Domain/Client Explanation.md#item-AllowedGrantType>) and [`ConsumedDeviceRequest::consume`](<../Authority/Redemption Explanation.md#item-ConsumedDeviceRequest--consume>), which finds only device requests of the presenting client. Fixtures first used here: [`seed_test_client`](<Test Fixtures Explanation.md#item-seed_test_client>) and [`TEST_CLIENT_ID`](<Test Fixtures Explanation.md#item-TEST_CLIENT_ID>).
