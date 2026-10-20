# Utilities

{{#covers apps/host/wildflower-server/authorization-server-rust/src/crypto_util/mod.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/crypto_util/base64.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/crypto_util/sha256.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/crypto_util/random_token.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/crypto_util/oauth_user_code.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/crypto_util/pkce.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/crypto_util/client_secret.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/crypto_util/public_jwk.rs}}

The mechanisms underneath the rules: encodings, digests, random secrets, the user code a person types, PKCE, secret hashing, and the public key's wire shape. **They know nothing of the product** and depend on nothing else in the crate. The rules that use them (what a token claims, when a secret matches, what a code may be redeemed for) live in the [Domain](<Domain Explanation.md>). Constant-time comparison is left to the `subtle` crate where it is needed.

## `crypto_util::base64`

The two RFC 4648 alphabets the server needs, named for their exact wire format so they can't be confused, and the only place a base64 engine is built. **URL-safe without padding** is the web's: opaque tokens, digests, and JWT and JWK key material. **Standard with padding** is only for HTTP Basic credentials at the token endpoint. The decoders' `DecodeError` is re-exported here, so no other module names the `base64` crate.

### `url_safe_no_pad_encode`

{{#item apps/host/wildflower-server/authorization-server-rust/src/crypto_util/base64.rs url_safe_no_pad_encode tests="tests::alphabets_differ_on_the_62nd_and_63rd_symbols"}}

### `url_safe_no_pad_decode`

{{#item apps/host/wildflower-server/authorization-server-rust/src/crypto_util/base64.rs url_safe_no_pad_decode}}

### `standard_encode`

{{#item apps/host/wildflower-server/authorization-server-rust/src/crypto_util/base64.rs standard_encode tests="tests::standard_pads_while_url_safe_does_not"}}

### `standard_decode`

{{#item apps/host/wildflower-server/authorization-server-rust/src/crypto_util/base64.rs standard_decode tests="tests::each_variant_round_trips"}}

## `crypto_util::sha256`

### `as_base64_no_pad`

**The at-rest form of a high-entropy secret**: a digest can't be reversed, so a leaked database yields nothing presentable. It is also the PKCE S256 transform, which [`compute_code_challenge`](#item-compute_code_challenge)'s test checks against RFC 7636's example.

{{#item apps/host/wildflower-server/authorization-server-rust/src/crypto_util/sha256.rs as_base64_no_pad}}

## `crypto_util::random_token`

**Every secret the server hands out that must be impossible to guess** is 32 bytes from the OS's secure generator, URL-safe base64 without padding. The value carries no structure. One construction serves [authorization codes](<Domain/Authorization Code Explanation.md>) and device codes, [refresh tokens](<Domain/Refresh Token Explanation.md>), SMART `launch` values and [same-device sign-in codes](<Domain/Same Device Sign In Codes Explanation.md>); each has its own name, so a call site says which it is minting.

### `generate_authorization_code`

{{#item apps/host/wildflower-server/authorization-server-rust/src/crypto_util/random_token.rs generate_authorization_code tests="tests::encodes_32_bytes_as_unpadded_base64url tests::successive_codes_differ"}}

### `generate_refresh_token`

{{#item apps/host/wildflower-server/authorization-server-rust/src/crypto_util/random_token.rs generate_refresh_token}}

### `generate_launch_nonce`

{{#item apps/host/wildflower-server/authorization-server-rust/src/crypto_util/random_token.rs generate_launch_nonce}}

### `generate_same_device_sign_in_code`

{{#item apps/host/wildflower-server/authorization-server-rust/src/crypto_util/random_token.rs generate_same_device_sign_in_code}}

### `token_storage_hash`

**How a secret is kept once handed out.** A refresh family records the digest of the authorization code that began it, so a replayed code can find and end the family.

{{#item apps/host/wildflower-server/authorization-server-rust/src/crypto_util/random_token.rs token_storage_hash}}

## `crypto_util::oauth_user_code`

**The short code a person types on the device page** to find a device's or a browser's [polled request](<Domain/Authorization Request/Polled Requests Explanation.md>): two blocks of four letters, `BCDF-GHJK`.

### `ALPHABET`

{{#item apps/host/wildflower-server/authorization-server-rust/src/crypto_util/oauth_user_code.rs ALPHABET tests="tests::alphabet_is_unambiguous_consonants"}}

### `BLOCK_LENGTH`

{{#item apps/host/wildflower-server/authorization-server-rust/src/crypto_util/oauth_user_code.rs BLOCK_LENGTH}}

### `BLOCK_COUNT`

{{#item apps/host/wildflower-server/authorization-server-rust/src/crypto_util/oauth_user_code.rs BLOCK_COUNT}}

### `generate_oauth_user_code`

The random source is a parameter, so a test can seed it.

{{#item apps/host/wildflower-server/authorization-server-rust/src/crypto_util/oauth_user_code.rs generate_oauth_user_code tests="tests::generated_code_is_valid"}}

### `is_valid_oauth_user_code`

{{#item apps/host/wildflower-server/authorization-server-rust/src/crypto_util/oauth_user_code.rs is_valid_oauth_user_code tests="tests::rejects_codes_with_wrong_alphabet tests::rejects_dashless_codes_on_block_count tests::rejects_codes_with_one_wrong_length_block tests::rejects_codes_with_too_many_blocks"}}

## `crypto_util::pkce`

**Proof that the app redeeming a code is the app that asked for it** (RFC 7636). The app sends `/oauth/authorize` a challenge, the S256 digest of a secret verifier it keeps, and sends the verifier itself to `/oauth/token`. The challenge's shape is checked at `/oauth/authorize`, the verifier's length at `/oauth/token`, and the challenge derived from the verifier is compared with the one the [code](<Domain/Authorization Code Explanation.md>) carries.

### `is_valid_code_verifier_length`

{{#item apps/host/wildflower-server/authorization-server-rust/src/crypto_util/pkce.rs is_valid_code_verifier_length}}

### `is_valid_s256_code_challenge`

{{#item apps/host/wildflower-server/authorization-server-rust/src/crypto_util/pkce.rs is_valid_s256_code_challenge tests="tests::s256_challenge_shape_is_43_base64url_chars"}}

### `compute_code_challenge`

{{#item apps/host/wildflower-server/authorization-server-rust/src/crypto_util/pkce.rs compute_code_challenge tests="tests::rfc7636_appendix_b_example"}}

## `crypto_util::client_secret`

**A confidential app's secret is stored only as an argon2id hash**, in the `secret_hash` of its [registration](<Domain/Client Explanation.md>). Verifying compares in constant time, so no caller compares secrets itself.

### `ClientSecretError`

{{#item apps/host/wildflower-server/authorization-server-rust/src/crypto_util/client_secret.rs ClientSecretError}}

### `hash_client_secret`

{{#item apps/host/wildflower-server/authorization-server-rust/src/crypto_util/client_secret.rs hash_client_secret tests="tests::hash_then_verify_roundtrips tests::same_secret_hashes_differently_each_time"}}

### `verify_client_secret`

{{#item apps/host/wildflower-server/authorization-server-rust/src/crypto_util/client_secret.rs verify_client_secret tests="tests::verify_rejects_wrong_secret tests::malformed_stored_hash_is_an_error"}}

## `crypto_util::public_jwk`

### `PublicJwk`

The [signing key](<Domain/Signing Key Explanation.md>) projects itself onto it ([`PublicJwk::from`](<Domain/Signing Key Explanation.md#item-PublicJwk--from>)).

{{#item apps/host/wildflower-server/authorization-server-rust/src/crypto_util/public_jwk.rs PublicJwk}}
