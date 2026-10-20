# Access Token Minter

<!-- markdownlint-disable-file link-fragments -- the item-… anchors are added when the book is built. -->

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/access_token_minter.rs}}

Every [access token](<../Domain/Access Token Explanation.md>) the server hands out is signed here: an app's at `/oauth/token`, a same-device session's at sign-in, a paired browser's when its pairing is claimed. **What a token claims comes from a [token entitlement](<../Authority/Token Entitlement Explanation.md>), never from a list a caller put together**, so what a token can be minted for is that enum's closed set of variants. The lifetime is the caller's: an app's [`ACCESS_TOKEN_TTL`](<../Domain/Access Token Explanation.md#item-ACCESS_TOKEN_TTL>), or the lifetime of the browser session the token is minted for.

## `domain::capabilities::writers::access_token_minter`

The tests load a minter with the [minter fixture](<Test Fixtures Explanation.md#access-token-minter>), over a key seeded by the test fake's {{#code-link apps/host/wildflower-server/authorization-server-rust/src/domain/test_fake/fixtures.rs seed_active_signing_key}}.

### `AccessTokenMinter`

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/access_token_minter.rs AccessTokenMinter}}

#### `with_active_key`

The key is the [signing key](<../Domain/Signing Key Explanation.md#item-SigningKey>) the server publishes for others to check its tokens. **With no active key, nothing can be minted.**

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/access_token_minter.rs AccessTokenMinter::with_active_key tests="tests::mint_fails_closed_without_an_active_key"}}

#### `mint`

The token is built by [`mint_access_token`](<../Domain/Access Token Explanation.md#item-mint_access_token>), which adds its own `jti` and times.

{{#item apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/access_token_minter.rs AccessTokenMinter::mint tests="tests::mint_signs_exactly_the_proofs_claims"}}

End to end, the [Smoke](<../Integration Tests/Smoke Explanation.md>) and [Grant Flows](<../Integration Tests/Grant Flows Explanation.md>) tests hold a minted token to passing this server's check and to carrying both SMART spellings in its `scope` claim.
