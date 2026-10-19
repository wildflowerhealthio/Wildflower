# Browser Pairing

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/browser_pairing.rs}}

A browser that isn't the Owner's, a laptop in the kitchen say, gets a [browser session](<../../Domain/Browser Session Explanation.md>) by pairing. It opens the pairing page, `/oauth/pair`, which starts a pairing (`POST /oauth/pair/start`), shows a `user_code`, and polls (`POST /oauth/pair/poll`). The Owner confirms that code at the device page and unticks whatever the browser shouldn't have. The first poll after the approval hands the browser its approved session's token, which it keeps as its browser session cookie.

**Pairing is no OAuth flow.** No app redeems it at `/oauth/token`, and it records no grant and no refresh family. Underneath it is an [authorization request](<../../Domain/Authorization Request Explanation.md>) of the pairing kind, asked for by the browser-session client, the one client every browser session's token is issued to. **The poll is bound to the request by its pairing code**, a 256-bit secret only the page that started the pairing holds, as a device holds its `device_code`. The `user_code` on screen identifies the request to the Owner; it can't collect the session.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/browser_pairing.rs BrowserPairing}}

It holds the store, the port that republishes the Owner's newest pending consent, the places a sign-in may send a browser on to, and the server's origin, which the session token names as its `iss` and `aud`. `new` builds it from those handles, lifted from the state.

{{#covered apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/browser_pairing.rs BrowserPairing::new}}

## `APPROVED_SESSION_TTL`

**An approved session lasts a day, absolute.** The session, its token, and so the browser's cookie all end 24 hours after the poll that starts them.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/browser_pairing.rs APPROVED_SESSION_TTL}}

## Test fixtures

`pairing` builds the capability over a fake store holding an active signing key and the seeded browser-session client, with an approval port that counts its republishes. It returns the key too, so a test can verify the token it mints.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/browser_pairing.rs tests::pairing}}

`approve` approves a pending pairing as the device page does, with the given scopes, under the name `Ruth's laptop`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/browser_pairing.rs tests::approve}}

## `start`

The pairing page starts a pairing with the `next` it should go on to once approved, and the name the browser's `User-Agent` suggests.

1. **`next` must be a path on this server.** An approved browser is sent on to the server's own `/oauth/authorize`, never off it. Anything else starts nothing.
2. The pairing code is a fresh 256-bit random token. A browser whose user agent names nothing recognizable goes by `Browser` until the page names it.
3. In one **write** scope: **a disabled browser-session client starts nothing**, since no session token could be issued to it. Then a unique `user_code` is drawn, as the [device flow's](<Device Authorizer Explanation.md#the-unique-user_code>) are, and the request is parked, pending, under the pairing code as its id, for the device flow's five minutes.
4. After the scope closes, the newest pending consent is republished, so the host notifies the Owner.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/browser_pairing.rs BrowserPairing::start}}

**A pairing asks for everything the Owner holds**, the most a browser session may hold. The Owner's card opens with everything they may delegate ticked, and they untick what the browser shouldn't have.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/browser_pairing.rs pairing_requested_scopes}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/browser_pairing.rs UNRECOGNIZED_BROWSER_NAME}}

The page gets back what it shows and polls with:

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/browser_pairing.rs StartedBrowserPairing}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/browser_pairing.rs BrowserPairingStartError}}

The browser-session client's row is seeded at boot, so a missing row is a store error, not an enabled client.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/browser_pairing.rs browser_session_client_is_disabled}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/browser_pairing.rs tests::a_start_parks_a_pending_pairing_and_notifies}}

A start from Firefox on Linux echoes `next`, the name, the TTL and the poll interval, and its pairing code isn't its `user_code`. The parked request, found by its `user_code`, is exactly a fresh pending pairing for the browser-session client, keyed by the pairing code and asking for the Owner's scopes. The Owner is notified once.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/browser_pairing.rs tests::a_browser_its_user_agent_doesn_t_name_goes_by_a_generic_name}}

With no name from the user agent, the pairing goes by `Browser`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/browser_pairing.rs tests::a_start_is_refused_for_a_foreign_next_or_a_disabled_client}}

An absolute URL, a scheme-relative one, an empty `next` and a relative path are all `NextNotAllowed`. Once the browser-session client is disabled, a good `next` is `BrowserSessionClientDisabled`. Nobody was notified.

Exercised end to end by [`a_browser_pairs_and_holds_a_day_long_session_with_the_approved_scopes`](<../../Integration Tests/Browser Pairing Explanation.md#a_browser_pairs_and_holds_a_day_long_session_with_the_approved_scopes>) and [`a_foreign_next_or_an_unknown_code_starts_and_finds_nothing`](<../../Integration Tests/Browser Pairing Explanation.md#a_foreign_next_or_an_unknown_code_starts_and_finds_nothing>).

## `poll`

The page polls with its pairing code and the name it now gives the browser. **The whole poll is one write scope.** A code that names no pairing (an unknown code, or another flow's request) is `NotFound`. A pairing past its expiry is `Expired`, whatever its status, so an approval the browser didn't collect in time is lost. Otherwise the status decides:

| Status     | What the poll does                                                         | The answer                 |
| ---------- | -------------------------------------------------------------------------- | -------------------------- |
| `Pending`  | Throttles to the poll interval, then stamps the poll and records the name. | `Pending` or `SlowDown`    |
| `Approved` | Claims the request, stores the approved session, mints its token.          | `Approved`, with the token |
| `Denied`   | Nothing.                                                                   | `Denied`                   |
| `Claimed`  | Nothing: an earlier poll started the session.                              | `Expired`                  |

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/browser_pairing.rs BrowserPairing::poll}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/browser_pairing.rs BrowserPairingStatus}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/browser_pairing.rs BrowserPairingPollError}}

The scope answers one of three things. Only a rename reaches back out: after the scope closes, the newest pending consent is republished, so the Owner's card shows the browser's new name.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/browser_pairing.rs PolledPairing}}

### While pending

**A poll sooner than the interval since the last one records nothing** and answers `SlowDown`. Otherwise the poll is stamped through [`stamp_pairing_poll`](<../../Domain/Authorization Request Explanation.md#stamp_pairing_poll>), under the name the page now gives, trimmed. A blank name keeps the one the pairing has.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/browser_pairing.rs record_poll}}

### Once approved

**The first poll after the approval claims the pairing and starts its session, and a claim, a stored session and a minted token land together or not at all.** The claim is the [`ClaimedBrowserPairing`](<../../Authority/Browser Pairing Explanation.md#claim>) proof: it moves the request from approved to claimed, so it starts one session at most, and carries a new approved session named as the Owner approved it, holding exactly the scopes the Owner granted. A poll that loses the claim to a concurrent one answers `Expired`. The [session writer](<../../Writers/Browser Session Writer Explanation.md#start_approved_session>) stores the session, and the [minter](<../../Writers/Access Token Minter Explanation.md#mint>) signs its day-long token for the browser-session client. If storing or minting fails, the error rolls the scope back, the claim with it, and the next poll tries again.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/browser_pairing.rs BrowserPairing::claim_approved_session}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/browser_pairing.rs tests::a_pending_poll_is_throttled_and_records_the_browser_s_name}}

A first poll under the same name answers `Pending` and republishes nothing. A second poll a second later is `SlowDown`, and the new name it carried isn't recorded. A poll one interval on records the trimmed `Kitchen laptop` and republishes. A blank name after another interval keeps `Kitchen laptop`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/browser_pairing.rs tests::the_first_poll_after_approval_starts_the_approved_session}}

After the Owner approves `wildflower/launch system/Patient.rs`, the first poll answers `Approved` with a token this server accepts: issued to the browser-session client, carrying exactly those scopes, living 24 hours, and naming its session. That session is stored as an approved one, named `Ruth's laptop`, with the same scopes and lifetime. The next poll answers `Expired`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/browser_pairing.rs tests::denied_expired_and_unknown_pairings_start_no_session}}

A denied pairing answers `Denied`. An approved pairing polled after its five minutes answers `Expired`. An unknown code, and the `device_code` of an approved device request, are `NotFound`.

Exercised end to end by [`a_browser_pairs_and_holds_a_day_long_session_with_the_approved_scopes`](<../../Integration Tests/Browser Pairing Explanation.md#a_browser_pairs_and_holds_a_day_long_session_with_the_approved_scopes>), [`a_declined_pairing_sets_no_cookie`](<../../Integration Tests/Browser Pairing Explanation.md#a_declined_pairing_sets_no_cookie>) and [`an_approval_grants_nothing_past_the_owner_s_scopes_or_the_approver_s`](<../../Integration Tests/Browser Pairing Explanation.md#an_approval_grants_nothing_past_the_owner_s_scopes_or_the_approver_s>).
