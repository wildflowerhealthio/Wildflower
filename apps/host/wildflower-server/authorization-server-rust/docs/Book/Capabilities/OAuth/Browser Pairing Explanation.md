# Browser Pairing

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/browser_pairing.rs}}

A browser that isn't the Owner's, a laptop in the kitchen say, gets a [browser session](<../../Domain/Browser Session Explanation.md>) by pairing. It opens the pairing page, `/oauth/pair`, which starts a pairing, shows a `user_code`, and polls. The Owner confirms that code at the [device page](<../Access/Device Consents Explanation.md>) and unticks whatever the browser shouldn't have. The first poll after the approval hands the browser its paired session's token, which it keeps as its browser session cookie.

**Pairing is no OAuth flow.** No app redeems it at `/oauth/token`, and it records no grant and no refresh family. Underneath it is a [pairing request](<../../Domain/Authorization Request/Polled Requests Explanation.md>), asked for by the browser-session client, the one client every browser session's token is issued to. It borrows the device flow's codes, lifetime and page: its `user_code` is drawn [as a device's is](<Device Authorizer Explanation.md#item-generate_unique_user_code>), and it lives the device flow's five minutes. **The poll is bound to the request by its pairing code**, a 256-bit secret only the page that started the pairing holds, as a device holds its `device_code`; the `user_code` on screen identifies the request to the Owner, but can't collect the session.

The first poll after the approval claims the pairing through the [`ClaimedBrowserPairing`](<../../Authority/Browser Pairing Explanation.md>) proof, the [browser session writer](<../../Writers/Browser Session Writer Explanation.md>) stores the paired session, and the [access token minter](<../../Writers/Access Token Minter Explanation.md>) signs its token, all in the poll's one write scope. If storing or minting fails, the claim rolls back with them and the next poll tries again.

The tests pair over the [pairing fixtures](<../Test Fixtures Explanation.md#browser-pairing>).

## `domain::capabilities::oauth::browser_pairing`

### `PAIRED_SESSION_TTL`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/browser_pairing.rs PAIRED_SESSION_TTL}}

### `UNRECOGNIZED_BROWSER_NAME`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/browser_pairing.rs UNRECOGNIZED_BROWSER_NAME}}

### `pairing_requested_scopes`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/browser_pairing.rs pairing_requested_scopes}}

### `StartedBrowserPairing`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/browser_pairing.rs StartedBrowserPairing}}

### `BrowserPairingStartError`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/browser_pairing.rs BrowserPairingStartError}}

### `BrowserPairingStatus`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/browser_pairing.rs BrowserPairingStatus}}

### `BrowserPairingPollError`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/browser_pairing.rs BrowserPairingPollError}}

### `BrowserPairing`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/browser_pairing.rs BrowserPairing}}

#### `new`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/browser_pairing.rs BrowserPairing::new}}

#### `start`

A `next` is allowed by the [sign-in destinations](<../../Domain/Same Device Sign In Codes Explanation.md#item-SignInDestinations--allow_on_this_server>), so an approved browser is sent on to the server's own `/oauth/authorize`, never off the server.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/browser_pairing.rs BrowserPairing::start tests="tests::a_start_parks_a_pending_pairing_and_notifies tests::a_browser_its_user_agent_doesn_t_name_goes_by_a_generic_name tests::a_start_is_refused_for_a_foreign_next_or_a_disabled_client"}}

#### `poll`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/browser_pairing.rs BrowserPairing::poll tests="tests::a_pending_poll_is_throttled_and_records_the_browser_s_name tests::the_first_poll_after_approval_starts_the_paired_session tests::denied_expired_and_unknown_pairings_start_no_session"}}

#### `claim_paired_session`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/browser_pairing.rs BrowserPairing::claim_paired_session}}

### `PolledPairing`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/browser_pairing.rs PolledPairing}}

### `record_poll`

The stamp is the pairing's own [`to_poll_stamped`](<../../Domain/Authorization Request/Polled Requests Explanation.md#item-PairingRequest--to_poll_stamped>).

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/browser_pairing.rs record_poll}}

### `is_browser_session_client_disabled`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/browser_pairing.rs is_browser_session_client_disabled}}
