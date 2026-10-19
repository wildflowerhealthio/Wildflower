# Utilities

{{#covers apps/host/wildflower-server/authorization-server-rust/src/crypto_util/mod.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/crypto_util/base64.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/crypto_util/sha256.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/crypto_util/random_token.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/crypto_util/oauth_user_code.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/crypto_util/pkce.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/crypto_util/client_secret.rs}}
{{#covers apps/host/wildflower-server/authorization-server-rust/src/crypto_util/public_jwk.rs}}

The mechanisms underneath the rules: encodings, digests, random secrets, the device flow's user code, PKCE, secret hashing, and the public key's wire shape. **They know nothing of the product** and depend on nothing else in the crate. The rules that use them (what a token claims, when a secret matches, what a code may be redeemed for) live in the domain. Constant-time comparison is left to the `subtle` crate where it is needed.

## Base64

The two RFC 4648 alphabets the server needs, named for their exact wire format so they can't be confused, and the only place a base64 engine is built. **URL-safe without padding** (`-`, `_`) is the web's: opaque tokens, digests, and JWT and JWK key material. **Standard with padding** (`+`, `/`, `=`) is only for HTTP Basic credentials at the token endpoint. The decoders' `DecodeError` is re-exported here, so no other module names the `base64` crate.

{{#code apps/host/wildflower-server/authorization-server-rust/src/crypto_util/base64.rs url_safe_no_pad_encode}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/crypto_util/base64.rs url_safe_no_pad_decode}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/crypto_util/base64.rs standard_encode}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/crypto_util/base64.rs standard_decode}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/crypto_util/base64.rs tests::standard_pads_while_url_safe_does_not}}

One byte leaves the last group short: the standard form pads it with `==`, the URL-safe form doesn't.

{{#code apps/host/wildflower-server/authorization-server-rust/src/crypto_util/base64.rs tests::alphabets_differ_on_the_62nd_and_63rd_symbols}}

The two alphabets differ only in their last two symbols: `+/` against `-_`.

{{#code apps/host/wildflower-server/authorization-server-rust/src/crypto_util/base64.rs tests::each_variant_round_trips}}

Each decoder gives back exactly what its encoder was given.

## `as_base64_no_pad`

SHA-256, then URL-safe base64. **The at-rest form of a high-entropy secret**: a digest can't be reversed, so a leaked database yields nothing presentable. It is also the PKCE S256 transform.

{{#code apps/host/wildflower-server/authorization-server-rust/src/crypto_util/sha256.rs as_base64_no_pad}}

No unit test of its own; the PKCE test below checks it against RFC 7636's example.

## Random tokens

**Every secret the server hands out that must be impossible to guess** is 32 bytes from the OS's secure generator, URL-safe base64 without padding: 256 bits, well past RFC 6749's bound of a 2^-128 chance of guessing. The value carries no structure. One construction serves authorization codes and device codes, refresh tokens, SMART `launch` values and same-device sign-in codes; each has its own name, so a call site says which it is minting.

{{#code apps/host/wildflower-server/authorization-server-rust/src/crypto_util/random_token.rs TOKEN_BYTES}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/crypto_util/random_token.rs generate_authorization_code}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/crypto_util/random_token.rs generate_refresh_token}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/crypto_util/random_token.rs generate_launch_nonce}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/crypto_util/random_token.rs generate_same_device_sign_in_code}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/crypto_util/random_token.rs tests::encodes_32_bytes_as_unpadded_base64url}}

A code is 43 URL-safe characters with no padding, and decodes back to exactly 32 bytes.

{{#code apps/host/wildflower-server/authorization-server-rust/src/crypto_util/random_token.rs tests::successive_codes_differ}}

Two codes in a row differ.

## `token_storage_hash`

**How a secret is kept once handed out**: its SHA-256 digest. Refresh tokens are stored and looked up by it; a refresh family records the digest of the authorization code that began it, so a replayed code can find and end the family; and the outstanding same-device sign-in codes are held by it. Public, so the integration tests can plant rows for plaintexts they know.

{{#code apps/host/wildflower-server/authorization-server-rust/src/crypto_util/random_token.rs token_storage_hash}}

No unit test of its own.

## The user code

**The short code a person types on the device page** to find a device's or a browser's request: two blocks of four letters, `BCDF-GHJK`. The letters are consonants other than `Y`, so there is no vowel, and no `0`, `1`, `I` or `O` to misread.

{{#code apps/host/wildflower-server/authorization-server-rust/src/crypto_util/oauth_user_code.rs ALPHABET}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/crypto_util/oauth_user_code.rs BLOCK_LENGTH}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/crypto_util/oauth_user_code.rs BLOCK_COUNT}}

### `generate_oauth_user_code`

Draw each letter from the alphabet, a dash between blocks. The random source is a parameter, so a test can seed it.

{{#code apps/host/wildflower-server/authorization-server-rust/src/crypto_util/oauth_user_code.rs generate_oauth_user_code}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/crypto_util/oauth_user_code.rs tests::generated_code_is_valid}}

A thousand codes from a seeded generator are all well formed.

{{#code apps/host/wildflower-server/authorization-server-rust/src/crypto_util/oauth_user_code.rs tests::alphabet_is_unambiguous_consonants}}

Every letter is an uppercase ASCII letter that is neither a vowel, nor `Y`, nor a digit.

### `is_valid_oauth_user_code`

Whether a string has the code's shape: exactly two blocks, each four letters of the alphabet, joined by a dash.

{{#code apps/host/wildflower-server/authorization-server-rust/src/crypto_util/oauth_user_code.rs is_valid_oauth_user_code}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/crypto_util/oauth_user_code.rs tests::rejects_codes_with_wrong_alphabet}}

Lowercase letters never pass.

{{#code apps/host/wildflower-server/authorization-server-rust/src/crypto_util/oauth_user_code.rs tests::rejects_dashless_codes_on_block_count}}

Valid letters with no dash are one block, refused on the count whatever their length.

{{#code apps/host/wildflower-server/authorization-server-rust/src/crypto_util/oauth_user_code.rs tests::rejects_codes_with_one_wrong_length_block}}

Two blocks with either one the wrong length are refused.

{{#code apps/host/wildflower-server/authorization-server-rust/src/crypto_util/oauth_user_code.rs tests::rejects_codes_with_too_many_blocks}}

Three well-formed blocks are refused.

## PKCE

**Proof that the app redeeming a code is the app that asked for it** (RFC 7636). The app sends `/oauth/authorize` a challenge, the S256 digest of a secret verifier it keeps, and sends the verifier itself to `/oauth/token`. S256 is the only method the server accepts.

`is_valid_s256_code_challenge` checks a challenge's shape at `/oauth/authorize`: exactly 43 URL-safe characters, what a SHA-256 digest encodes to. The RFC's grammar also allows `.` and `~`, which that encoding never produces.

{{#code apps/host/wildflower-server/authorization-server-rust/src/crypto_util/pkce.rs is_valid_s256_code_challenge}}

`is_valid_code_verifier_length` checks a verifier at `/oauth/token`: 43 to 128 characters, counted as Unicode scalar values.

{{#code apps/host/wildflower-server/authorization-server-rust/src/crypto_util/pkce.rs is_valid_code_verifier_length}}

`compute_code_challenge` derives the challenge from the verifier, for comparison with the stored one.

{{#code apps/host/wildflower-server/authorization-server-rust/src/crypto_util/pkce.rs compute_code_challenge}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/crypto_util/pkce.rs tests::rfc7636_appendix_b_example}}

The RFC's own verifier gives the RFC's own challenge, and that challenge has the valid shape.

{{#code apps/host/wildflower-server/authorization-server-rust/src/crypto_util/pkce.rs tests::s256_challenge_shape_is_43_base64url_chars}}

42 or 44 characters are refused, and so is 43 ending in `=` or `.`.

## Client secrets

**A confidential app's secret is stored only as an argon2id hash**, in a self-describing PHC string that carries the algorithm, its parameters and a fresh random salt. Verifying re-derives the hash with the stored parameters and compares in constant time, so no caller compares secrets itself.

{{#code apps/host/wildflower-server/authorization-server-rust/src/crypto_util/client_secret.rs ClientSecretError}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/crypto_util/client_secret.rs hash_client_secret}}

A mismatch is `Ok(false)`; only a stored value that isn't a PHC string, or a failure other than a mismatch, is an error.

{{#code apps/host/wildflower-server/authorization-server-rust/src/crypto_util/client_secret.rs verify_client_secret}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/crypto_util/client_secret.rs tests::hash_then_verify_roundtrips}}

A hash names itself argon2id, and the secret verifies against it.

{{#code apps/host/wildflower-server/authorization-server-rust/src/crypto_util/client_secret.rs tests::verify_rejects_wrong_secret}}

Another secret doesn't.

{{#code apps/host/wildflower-server/authorization-server-rust/src/crypto_util/client_secret.rs tests::same_secret_hashes_differently_each_time}}

The same secret hashed twice gives two strings, and both verify.

{{#code apps/host/wildflower-server/authorization-server-rust/src/crypto_util/client_secret.rs tests::malformed_stored_hash_is_an_error}}

A stored value that isn't a PHC string is an error, not a mismatch.

## `PublicJwk`

**The public half of a signing key, as `/.well-known/jwks.json` publishes it**: an RSA key for `RS256`, usable only to verify, named by the `kid` a token's header carries. The [signing key](<Domain/Signing Key Explanation.md#publishing>) projects itself onto it.

{{#code apps/host/wildflower-server/authorization-server-rust/src/crypto_util/public_jwk.rs PublicJwk}}
