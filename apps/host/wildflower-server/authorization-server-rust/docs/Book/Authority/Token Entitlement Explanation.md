# Token Entitlement

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/authority/token_entitlement.rs}}

An access token says who it was issued to, what it may do, for which patient, and in which browser session. **None of that is ever assembled by a caller.** A **token entitlement** is the proof a token is minted under: one variant per proof a token may be minted for, each carrying the token's claims privately, copied from the record or configuration it stands for. The [access-token minter](<../Writers/Access Token Minter Explanation.md#mint>) takes nothing else, so a token's scopes are never a slice someone put together.

## `TokenEntitlement`

The variants are the whole answer to "what can a token be minted for?". It is an enum, not a trait, so that list is closed and in one place.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/token_entitlement.rs TokenEntitlement keep-docs}}

| Variant             | The proof                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| `SameDeviceSignIn`  | [A redeemed sign-in code](<Same Device Sign In Explanation.md>): the Owner's browser session.              |
| `BrowserPairing`    | [A claimed pairing](<Browser Pairing Explanation.md>): an approved browser session.                        |
| `AuthorizationCode` | [A code redeemed](<Redemption Explanation.md#redeemedauthorizationcode>) at `/oauth/token`.                |
| `DeviceCode`        | [An approved device request](<Redemption Explanation.md#consumeddevicerequest>) claimed by its poll.       |
| `RefreshToken`      | [A live refresh token](<Redemption Explanation.md#validatedrefreshtoken>), validated before it is rotated. |

Each claim below is read off the proof the variant holds. No unit test of the entitlement's own; the minter's [`mint_signs_exactly_the_proofs_claims`](<../Writers/Access Token Minter Explanation.md#mint>) shows a token carrying exactly what a redeemed code's entitlement holds.

## `client_id`

The token's `sub` and `client_id`: the browser-session client for a browser session's token, the redeeming app for the rest.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/token_entitlement.rs TokenEntitlement::client_id}}

## `token_scopes`

The token's `scope` claim, exactly as the proof holds it. A redemption's are its recorded scopes with each SMART scope's alternate spelling added. A browser session's are the session's scopes as stored.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/token_entitlement.rs TokenEntitlement::token_scopes}}

Exercised end to end by [`minted_jwt_scope_claim_carries_alternate_canonical_forms`](<../Integration Tests/Grant Flows Explanation.md#minted_jwt_scope_claim_carries_alternate_canonical_forms>).

## `patient`

The SMART patient context bound at approval, if any. **A browser session's token has none.**

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/token_entitlement.rs TokenEntitlement::patient}}

## `sid`

The browser session the token is minted under, its `sid`: the session a sign-in or a pairing started, the session a redeemed code was issued in, or the one a refreshed family records. **A device-code token has none**: a device pairs with no browser.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/authority/token_entitlement.rs TokenEntitlement::sid}}

Revoking a browser session ends every token naming it: see [Browser Session](<../Domain/Browser Session Explanation.md>).
