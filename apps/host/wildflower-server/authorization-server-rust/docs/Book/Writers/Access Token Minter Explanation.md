# Access Token Minter

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/access_token_minter.rs}}

Every access token the server hands out is signed here: an app's at `/oauth/token`, an Owner session's at sign-in, an approved browser's when its pairing is claimed. **What a token claims (the app, the scopes, the patient, the browser session) comes from a [`TokenEntitlement`](<../Authority/Token Entitlement Explanation.md#tokenentitlement>) proof, never from a list a caller put together**, so what a token can be minted for is that enum's closed set of variants. Where the token is valid and for how long are fixed when the minter is built: the server's own origin is both its issuer and its audience, and the lifetime is the caller's (an app's access token, an Owner session, an approved session).

Reading the signing key's private material is the privileged read, so the minter is loaded inside the caller's scope. Signing is pure computation over the key it loaded, so a signing failure rolls the scope back with everything else the operation wrote.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/access_token_minter.rs AccessTokenMinter}}

## Test fixtures

`minter` loads a minter from the fake store for `https://server.example`, minting five-minute tokens:

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/access_token_minter.rs tests::minter}}

## `with_active_key`

The minter holds the [signing key](<../Domain/Signing Key Explanation.md>) that was active when it was loaded. **With no active key, nothing can be minted**: loading fails, rather than minting an unsigned token or one signed with something else.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/access_token_minter.rs AccessTokenMinter::with_active_key}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/access_token_minter.rs tests::mint_fails_closed_without_an_active_key}}

A store with no key seeded answers `NoActiveSigningKey`.

## `mint`

A token carrying exactly the entitlement's app (as its subject, `sub`), its token scopes, its patient and its browser session, issued by and for the server's origin, signed by [`mint_access_token`](<../Domain/Token Explanation.md#mint_access_token>).

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/access_token_minter.rs AccessTokenMinter::mint}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/access_token_minter.rs tests::mint_signs_exactly_the_proofs_claims}}

A token minted for a redeemed code verifies against the seeded key, names the code's app as its subject, carries the proof's token scopes and patient, and names the server's origin as both `iss` and `aud`.

Exercised end to end by [`a_token_for_this_server_passes`](<../Integration Tests/Smoke Explanation.md#a_token_for_this_server_passes>) and [`minted_jwt_scope_claim_carries_alternate_canonical_forms`](<../Integration Tests/Grant Flows Explanation.md#minted_jwt_scope_claim_carries_alternate_canonical_forms>).
