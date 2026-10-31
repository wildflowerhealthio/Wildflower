# Session Widening

<!-- markdownlint-disable-file link-fragments -- the item-… anchors are added when the book is built. -->

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/authority/session_widening.rs}}

A [session widening](<../Domain/Authorization Request/Session Widening Explanation.md>) the Owner approved has already grown its browser session's scopes. What is left is the browser's token: its cookie still carries the narrower scopes. **The limited page's poll claims the approval once and mints the session a new token**, for the same session, carrying what it holds now.

A **claimed session widening** is the authority that token is minted under. Only the browser whose session cookie names the widening's session can poll for it, so the claim is proof that the browser polling is the one the Owner widened. The proof holds the session as its row stands, live when the claim landed; the [token entitlement](<Token Entitlement Explanation.md>) reads the token's `sub`, `scope` and `sid` off it, and the minter makes it live until the session ends.

## `domain::authority::session_widening`

### `ClaimedSessionWidening`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/session_widening.rs ClaimedSessionWidening}}

#### `claim`

The one constructor. The claim is the widening's own [`to_claimed`](<../Domain/Authorization Request/Session Widening Explanation.md#item-SessionWideningRequest--to_claimed>) transition, written with the [guarded replace](<../Domain/Authorization Request Explanation.md#transitions-and-the-guarded-replace>), so **an approved widening mints one token at most**. A widening whose session has ended is not claimed: there is nothing to mint for.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/session_widening.rs ClaimedSessionWidening::claim tests="tests::an_approved_widening_is_claimed_once_for_the_session_as_it_stands tests::a_widening_of_an_ended_session_is_not_claimed"}}

#### `client_id`, `token_scopes` and `session`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/session_widening.rs ClaimedSessionWidening::client_id}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/session_widening.rs ClaimedSessionWidening::token_scopes}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/session_widening.rs ClaimedSessionWidening::session}}

The tests store a widened session and a widening of it:

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/session_widening.rs tests::widened_session_and_widening}}

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/session_widening.rs tests::stored}}
