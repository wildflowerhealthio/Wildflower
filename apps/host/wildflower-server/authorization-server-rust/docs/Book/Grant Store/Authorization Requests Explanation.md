# Authorization Requests

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/authorization_requests.rs}}

Every [authorization request](<../Domain/Authorization Request Explanation.md>) lives here from the moment it starts until the [retention sweep](<../Domain/Retention Explanation.md#item-purge_expired>) removes it, in one of three tables: `code_authorization_requests` for an app's [code request](<../Domain/Authorization Request/Code Request Explanation.md>), `user_code_requests` for the [device requests and browser pairings](<../Domain/Authorization Request/Polled Requests Explanation.md>) a poll claims, and `session_widening_requests` for the [session widenings](<../Domain/Authorization Request/Session Widening Explanation.md>) the limited page's poll claims. A request's row is the shared record that the app or device polling, the browser waiting and the Owner deciding all read and write.

**The rule these tables keep is that a decision lands once**: a transition is written only over the row as it was read. That guarded replace, and the races it settles, are on the domain page: [Transitions and the guarded replace](<../Domain/Authorization Request Explanation.md#transitions-and-the-guarded-replace>).

**Only one pending request may hold a given `user_code`.** The Owner types the code at the device page, and the pending lookup is what finds the request, so a finished request holding the same code must never answer for a live one. Minting a fresh code takes the other lookup, which sees every status: a candidate is used only if no request, live or finished, already bears it.

The two reads that span flows serve the host: [`owner_prompt`](<../Domain/Owner Prompt Explanation.md#item-OwnerPrompt>) is the one request the host notifies about and opens for the Owner, and `is_awaiting_owner` tells the host whether the consent it holds open is still undecided.

## `domain::grant_store::authorization_requests`

### `AuthorizationRequestsTx`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/authorization_requests.rs AuthorizationRequestsTx}}
