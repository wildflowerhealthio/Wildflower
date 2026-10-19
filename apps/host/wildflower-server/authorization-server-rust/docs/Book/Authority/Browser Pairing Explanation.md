# Browser Pairing

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/authority/browser_pairing.rs}}

A browser that isn't on the server's own device pairs. Its page starts a pairing request and shows the Owner a code; the Owner approves it on the device page, choosing what the browser may hold; the page, polling all along, then picks up its session. **Only the page that started the pairing holds the pairing code the request is keyed on, so a claim is proof that the browser now polling is the one the Owner approved.**

A **claimed browser pairing** is that proof: an approved pairing, claimed once. It is the authority an **approved browser session** is started under, and its token minted under. The session holds exactly the scopes the Owner granted at approval; the token is issued to the browser-session client and names the session as its `sid`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/browser_pairing.rs ClaimedBrowserPairing}}

What the minter reads off it, through [`TokenEntitlement::BrowserPairing`](<Token Entitlement Explanation.md#tokenentitlement>), are the token's `sub` (the browser-session client), its `scope` (the session's scopes, as the Owner granted them) and its `sid`:

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/browser_pairing.rs ClaimedBrowserPairing::client_id}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/browser_pairing.rs ClaimedBrowserPairing::token_scopes}}

## Test fixtures

Approved sessions in the tests last a day.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/browser_pairing.rs tests::SESSION_TTL}}

`pairing` is a pending pairing request from the browser-session client, from a browser that calls itself `Firefox on Linux`, live for five minutes.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/browser_pairing.rs tests::pairing}}

`stored` reads a request back from the store.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/browser_pairing.rs tests::stored}}

`approved_pairing` stores a pairing and approves it with the shared [`approve_stored`](<../Grant Store/Test Fake Explanation.md#approve_stored>) fixture, granting `wildflower/launch` and `system/*.rs` and renaming the browser `Ruth's laptop`, as the Owner would on the device page.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/browser_pairing.rs tests::approved_pairing}}

## `claim`

The one constructor. **An approved pairing starts one session at most.** A request that isn't an approved pairing claims nothing. An approved one is moved from approved to claimed through the guarded replace, with the request's [`claim`](<../Domain/Authorization Request Explanation.md#claim>) transition; a concurrent poll that claimed it first wins, and this one gets nothing. The winner's proof holds a new [approved session](<../Domain/Browser Session Explanation.md#new_approved>), named as the request's browser is named (the Owner's rename, or the browser's own), with the scopes the Owner granted, lasting the TTL the caller passes from now.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/browser_pairing.rs ClaimedBrowserPairing::claim}}

The pairing capability claims it inside the poll's write scope, then stores the session with the browser-session writer's [`start_approved_session`](<../Writers/Browser Session Writer Explanation.md#start_approved_session>) and mints its token with [`mint`](<../Writers/Access Token Minter Explanation.md#mint>). A poll that loses the claim is answered as expired.

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/browser_pairing.rs tests::only_an_approved_pairing_is_claimed}}

A pending pairing claims nothing, and neither does an approved device request, which stays approved.

Exercised end to end by [`a_browser_pairs_and_holds_a_day_long_session_with_the_approved_scopes`](<../Integration Tests/Browser Pairing Explanation.md#a_browser_pairs_and_holds_a_day_long_session_with_the_approved_scopes>).

## `session`

The approved session the claim starts: the row the browser-session writer stores, and the token's `sid`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/browser_pairing.rs ClaimedBrowserPairing::session}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/browser_pairing.rs tests::an_approved_pairing_is_claimed_once_for_an_approved_session}}

The claim's session is an approved one, named `Ruth's laptop`, with the approved scopes and the TTL; the proof names the browser-session client and the same scopes; the request is now claimed, and a second claim loses.
