# Browser Pairing

<!-- markdownlint-disable-file link-fragments -- the item-… anchors are added when the book is built. -->

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/authority/browser_pairing.rs}}

A browser that isn't on the server's own device pairs. Its page starts a [pairing request](<../Domain/Authorization Request/Polled Requests Explanation.md#item-PairingRequest>) and shows the Owner a code; the Owner approves it on the device page, choosing what the browser may hold; the page, polling all along, then picks up its session. **Only the page that started the pairing holds the pairing code the request is keyed on, so a claim is proof that the browser now polling is the one the Owner approved.**

A **claimed browser pairing** is that proof. It is the authority a paired [browser session](<../Domain/Browser Session Explanation.md>) is started under and its [access token](<../Domain/Access Token Explanation.md>) minted under. Approving the pairing starts no session; claiming it does. The pairing capability claims it inside the poll's write scope, then hands it to the browser-session writer to store the session and to the access-token minter to mint the token. A poll that loses the claim is answered as expired.

## `domain::authority::browser_pairing`

The tests store and approve pairings with the [pairing fixtures](<Test Fixtures Explanation.md#browser-pairing>).

### `ClaimedBrowserPairing`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/browser_pairing.rs ClaimedBrowserPairing}}

#### `claim`

The one constructor. The claim is the request's own [`claim`](<../Domain/Authorization Request/Polled Requests Explanation.md#item-PairingRequest--claim>) transition, written with the [guarded replace](<../Domain/Authorization Request Explanation.md#transitions-and-the-guarded-replace>), so **an approved pairing starts one session at most**. The session is a [new paired session](<../Domain/Browser Session Explanation.md#item-BrowserSession--new_paired_session>), named as the Owner renamed the browser or as it named itself.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/browser_pairing.rs ClaimedBrowserPairing::claim tests="tests::only_an_approved_pairing_is_claimed"}}

#### `session`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/browser_pairing.rs ClaimedBrowserPairing::session tests="tests::an_approved_pairing_is_claimed_once_for_a_paired_session"}}

End to end, the [Browser Pairing](<../Integration Tests/Browser Pairing Explanation.md>) tests hold a paired browser to a day-long session with the approved scopes.

#### `client_id` and `token_scopes`

What the [token entitlement](<Token Entitlement Explanation.md>) reads off the proof.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/browser_pairing.rs ClaimedBrowserPairing::client_id}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/browser_pairing.rs ClaimedBrowserPairing::token_scopes}}
