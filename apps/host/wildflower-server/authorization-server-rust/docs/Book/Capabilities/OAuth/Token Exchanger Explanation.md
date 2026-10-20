# Token Exchanger

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/token_exchanger.rs}}

`POST /oauth/token` is where an app turns what it was given into an [access token](<../../Domain/Access Token Explanation.md>) it can call the FHIR server with. It has three ways in: an [authorization code](<../../Domain/Authorization Code Explanation.md>) the Owner's approval issued, a device request the Owner approved, or a [refresh token](<../../Domain/Refresh Token Explanation.md>) from an earlier exchange. The token exchanger runs all three, always for an app that has [authenticated](<Client Authenticator Explanation.md>).

Every exchange has the same spine. **The app must be registered for the grant type it uses**, checked before any scope opens, so a refused app spends nothing. Then, inside a write scope: obtain the redemption proof from the [Redemption](<../../Authority/Redemption Explanation.md>) authority, load the signing key, start or rotate the refresh family through the [refresh family writer](<../../Writers/Refresh Family Writer Explanation.md>), and sign the token through the [access token minter](<../../Writers/Access Token Minter Explanation.md>). **The proof is the hand-off between checking and writing**, so a token is never minted for a grant that didn't redeem.

**Signing runs inside the scope, so a signing failure undoes the exchange**: the code stays unspent, the device request unclaimed, the refresh token unrotated, and the app can try again. A refusal is different. Some refusals must keep what they wrote (the spent code of a failed redemption, the stamped poll of a device that polled too early, the ended family of a replayed refresh token), so a refusal comes back inside the scope's answer, and the scope commits.

The tests exchange through an [exchanger over a fresh fake](<../Test Fixtures Explanation.md#token-exchanger>), with codes issued for a fixed PKCE verifier.

## `domain::capabilities::oauth::token_exchanger`

### `IssuedTokens`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/token_exchanger.rs IssuedTokens}}

### `ExchangeOutcome`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/token_exchanger.rs ExchangeOutcome}}

### `TokenExchanger`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/token_exchanger.rs TokenExchanger}}

#### `new`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/token_exchanger.rs TokenExchanger::new}}

#### `exchange_authorization_code`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/token_exchanger.rs TokenExchanger::exchange_authorization_code tests="tests::a_client_without_the_grant_type_is_refused_before_redemption tests::a_code_exchange_mints_for_the_granted_scopes"}}

#### `exchange_device_code`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/token_exchanger.rs TokenExchanger::exchange_device_code}}

#### `exchange_refresh_token`

An epoch bumped between the two scopes doesn't stop this one rotation, as the epoch isn't read again; but the family still began before the epoch, so its next refresh is refused.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/token_exchanger.rs TokenExchanger::exchange_refresh_token tests="tests::a_refresh_exchange_rotates_and_a_replay_revokes_the_family"}}

#### `redeem_code_in`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/token_exchanger.rs TokenExchanger::redeem_code_in}}

#### `claim_device_request_in`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/token_exchanger.rs TokenExchanger::claim_device_request_in}}

#### `rotate_refresh_token_in`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/token_exchanger.rs TokenExchanger::rotate_refresh_token_in}}

#### `prepare_issuance`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/token_exchanger.rs TokenExchanger::prepare_issuance}}

### `ensure_grant_type_allowed`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/token_exchanger.rs ensure_grant_type_allowed}}

### `issue`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/oauth/token_exchanger.rs issue}}
