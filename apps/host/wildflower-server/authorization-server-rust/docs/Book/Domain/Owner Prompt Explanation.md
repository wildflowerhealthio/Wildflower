# Owner Prompt

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/owner_prompt.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/consent_key.rs}}

The Owner is asked about one request at a time: the newest one waiting for them, of any flow. A request waits for the Owner while it is [pending](<Authorization Request Explanation.md#item-AuthorizationRequest--is_pending_at>), unexpired, and from a client that isn't disabled; a [code request](<Authorization Request/Code Request Explanation.md>) still on its browser's limited page doesn't, yet. It works like a stack: a new request takes over from the one before it, and deciding it brings back the newest of those still waiting. The [Jargon](<../../../../../../../slices/authorization/docs/Jargon Explanation.md#pending-consents>) says how the host learns of it.

The three flows share no lookup key. A device request and a browser pairing are found by the `user_code` the Owner types at the device page; a code request by its `id`, at its consent card. So both types here are discriminated by flow, each variant carrying the key its consent surface already fetches by:

- an **Owner prompt** is what the host shows: the key, plus the name of what asks, for the notification;
- a **consent key** names one request by the same key, without the name. The host's server status carries it, and asks the store whether the request it names is still awaiting the Owner.

The store answers both: {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/authorization_requests.rs AuthorizationRequestsTx::owner_prompt}} reads the newest waiting request of each flow and keeps the later, and {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/grant_store/authorization_requests.rs AuthorizationRequestsTx::is_awaiting_owner}} reads the one a key names. Their tests are with the [SQLite adapter](<../Persistence/Authorization Requests Explanation.md>).

## `domain::owner_prompt`

### `OwnerPrompt`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/owner_prompt.rs OwnerPrompt}}

#### `for_request`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/owner_prompt.rs OwnerPrompt::for_request}}

## `domain::consent_key`

### `ConsentKey`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/consent_key.rs ConsentKey}}
