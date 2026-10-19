# Token Verifier

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/token_verifier.rs}}

The token verifier answers one question for every request that presents an access token: **is this a live token this server minted for itself?** It is the single place that question is answered. Both bearer gates run it, the browser-session cookie checks run it, and the host's FHIR server runs it in process, so a token is accepted or refused the same way wherever it is presented.

Its answer is the token's [`VerifiedClaims`](<../../Domain/Token Explanation.md#verifiedclaims>), or a [`VerifyError`](<../../Domain/Token Explanation.md#verifyerror>) saying why not. The checks run in a fixed order, and **revocation comes last**: a token is first proven genuine, and only then asked whether it has since been withdrawn.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/token_verifier.rs TokenVerifier}}

| Field           | What it holds                                                                                                                           |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `store`         | The grant store, for the signing keys and the browser sessions.                                                                         |
| `revocation`    | The host's revocation check: the per-`jti` denylist and the per-subject epoch, kept outside the grant store.                            |
| `server_origin` | The server's bare origin, the only `iss` and the only `aud` a token may carry. A token another server minted is refused by these alone. |

## Test fixtures

The tests verify against the fake store with one active signing key seeded, and a revocation check that answers from a fixed list of revoked `jti`s, records which subjects it was asked about, and can be told to fail.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/token_verifier.rs tests::FakeRevocation}}

`ORIGIN` is this server's origin and `OTHER_ORIGIN` another server's. `store_with_key` seeds the fake store with a signing key and returns both; `verifier` builds a verifier over that store with nothing revoked.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/token_verifier.rs tests::store_with_key}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/token_verifier.rs tests::verifier}}

`mint` and `mint_under_session` sign a five-minute token for `client`, naming the issuer and audience the test chooses, under a browser session's `sid` or none.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/token_verifier.rs tests::mint}}

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/token_verifier.rs tests::mint_under_session}}

## `new`

The verifier is built from the state's store, its revocation check and its origin, by the [session bindings](<../../Assembly/Session Bindings Explanation.md>). It holds no other configuration: what it accepts is decided by the keys in the store and the origin alone.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/token_verifier.rs TokenVerifier::new}}

Every test below builds one.

## `verify`

**A token is accepted only if it is signed with one of the server's keys, unexpired, issued by this server's origin for this server's origin, and withdrawn by nothing.** The checks run in two steps.

Inside one read scope, the verifier loads every signing key and runs [`verify_jwt`](<../../Domain/Token Explanation.md#verify_jwt>) with the server's origin as the only issuer and the only audience; that checks the signature, the expiry, `iss` and `aud`. If the token names a browser session in its `sid`, the verifier then asks the store whether that session is revoked ([`browser_session_is_revoked`](<../../Grant Store/Browser Sessions Explanation.md#browser_session_is_revoked>)). The store answers revoked for a `sid` that names no session row, so a token naming a session the server never had is refused too. A token with no `sid` has no session to check.

After the scope closes, the verifier asks the host's revocation check about the token's `jti`, its issue time and its subject. That covers a logout's denylisted `jti`, and an Owner revoke or a grant revoke that moved the subject's epoch past the token's issue time.

**Every store failure fails closed.** A connection that can't be had, or a key read that fails, is `KeyStoreUnavailable`; a session read that fails is `BrowserSessionStoreUnavailable`; a revocation check that fails is `RevocationStoreUnavailable`. None of them admits the token, and the gates answer each with a `500`, not a `401` (see [`verify_error_response`](<../../HTTP/Errors and Wire Shapes Explanation.md#verify_error_response>)).

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/token_verifier.rs TokenVerifier::verify}}

The first step is a private helper:

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/token_verifier.rs TokenVerifier::verify_signed_and_session_live}}

### What it looks like

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/token_verifier.rs tests::verifies_a_token_for_this_server_and_consults_revocation}}

A token naming this server as `iss` and `aud` verifies, its subject comes back in the claims, and the revocation check was asked about that subject once.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/token_verifier.rs tests::rejects_a_token_for_another_server}}

A token signed with this server's own key is still `TokenRejected` when another server's origin is its issuer, its audience, or both.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/token_verifier.rs tests::rejects_a_path_under_the_origin_as_audience}}

The audience must be the bare origin: a token for `{origin}/fhir-r4` is rejected.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/token_verifier.rs tests::revocation_is_the_last_gate_and_fails_closed}}

A genuine token whose `jti` is on the denylist is `Revoked`, and when the revocation check fails, the same token is `RevocationStoreUnavailable`, not accepted.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/session/token_verifier.rs tests::a_token_is_revoked_with_its_browser_session}}

A token minted under a stored browser session verifies and carries its `sid`; one naming a `sid` with no session row is `Revoked`; once the session is revoked its token is `Revoked` too, while a token with no `sid` still verifies.

Exercised end to end by [`a_token_for_this_server_passes`](<../../Integration Tests/Smoke Explanation.md#a_token_for_this_server_passes>), [`a_token_not_naming_this_server_as_iss_and_aud_is_rejected`](<../../Integration Tests/Smoke Explanation.md#a_token_not_naming_this_server_as_iss_and_aud_is_rejected>), [`gate_rejects_a_revoked_jti`](<../../Integration Tests/Revocation Explanation.md#gate_rejects_a_revoked_jti>), [`gate_rejects_after_subject_epoch_bump`](<../../Integration Tests/Revocation Explanation.md#gate_rejects_after_subject_epoch_bump>) and [`revoking_a_session_stops_its_authorization_and_fhir_requests`](<../../Integration Tests/Browser Sessions Explanation.md#revoking_a_session_stops_its_authorization_and_fhir_requests>).
