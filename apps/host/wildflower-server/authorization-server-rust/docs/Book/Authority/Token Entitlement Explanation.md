# Token Entitlement

<!-- markdownlint-disable-file link-fragments -- the item-… anchors are added when the book is built. -->

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/authority/token_entitlement.rs}}

An [access token](<../Domain/Access Token Explanation.md>) says who it was issued to, what it may do, for which patient, and in which browser session. **None of that is ever assembled by a caller.** A **token entitlement** is the proof a token is minted under: one variant per proof on the pages before this one that a token may be minted for. The access-token minter takes nothing else, so a token's claims are always the ones a check produced.

Each variant reads its claims off the proof it holds:

- a [redeemed sign-in code](<Same Device Sign In Explanation.md>) or a [claimed pairing](<Browser Pairing Explanation.md>) gives the browser-session client, and the session's scopes and `sid`;
- a [redeemed code](<Redemption Explanation.md#item-RedeemedAuthorizationCode>), a [claimed device request](<Redemption Explanation.md#item-ConsumedDeviceRequest>) or a [validated refresh token](<Redemption Explanation.md#item-ValidatedRefreshToken>) gives the redeeming app, and the scopes, patient and `sid` of the record redeemed.

The entitlement has no unit test of its own. The access-token minter's test, on the [Access Token Minter](<../Writers/Access Token Minter Explanation.md>) page, shows a token carrying exactly what a redeemed code's entitlement holds.

## `domain::authority::token_entitlement`

### `TokenEntitlement`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/token_entitlement.rs TokenEntitlement}}

#### `client_id`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/token_entitlement.rs TokenEntitlement::client_id}}

#### `token_scopes`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/token_entitlement.rs TokenEntitlement::token_scopes}}

#### `patient`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/token_entitlement.rs TokenEntitlement::patient}}

#### `sid`

[Revoking a browser session](<../Domain/Browser Session Explanation.md>) ends every token whose `sid` names it.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/authority/token_entitlement.rs TokenEntitlement::sid}}
