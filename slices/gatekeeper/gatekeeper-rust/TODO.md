# Gatekeeper authority refactor — handoff

A chain of stacked PRs moving every privileged write in `gatekeeper-rust` behind
a **writer** whose method demands an **authority proof**, so a security audit is
two short lists (the proof constructors in `src/domain/authority/`, the writers
in `src/domain/capabilities/writers/`) instead of a reading of every flow. This
file tracks what each PR does and is deleted by the last one.

## Invariant being built

A token's scopes come from a redemption proof; that proof's scopes were copied
from a code or refresh family; those were recorded under a `DelegatedScopes`
proof; that proof was clamped to what the approving Owner held. The one authority
outside the chain is the host's own boot-time owner token (`HostBootstrap`,
constructible only in `seeding.rs`).

## PR chain

1. **`claude/gatekeeper-auth-structure-dx2mrd` — authority and writers.** DONE.
   `domain/authority/` (`DelegatedScopes`, `HostBootstrap`, sealed
   `MintAuthority`), `domain/capabilities/writers/` (`RequestApprover`,
   `GrantRecorder`, `AccessTokenMinter`), the consent decider and the boot-time
   mint routed through them, `capabilities/` split into `access/` + `writers/`,
   the privileged-call source guard with an explicit `IN_FLIGHT` list, and the
   unused owner-bearer helpers deleted.
2. **`…-2-client-auth` — client authentication to domain.** DONE.
   `AuthenticatedClient` proof (`domain/authority/authenticated_client.rs`,
   argon2 + disabled checks as its one constructor), domain `ClientCredentials`
   (zeroized) with the HTTP `PresentedCredentials` wrapper carrying
   `presented_via`, `ClientAuthenticationError` variants rendered by
   `ClientAuthenticationFailure` in `internal.rs`. The `TokenRequest` extractor
   authenticates through `LiveClientAuthenticator` and yields the proof (same
   check order as before); the exchange handlers take `&AuthenticatedClient`.
   `require_valid_client_for_token` deleted.
3. **`…-3-token-exchange` — the three redemptions.** DONE.
   `RedeemedAuthorizationCode`, `ConsumedDeviceRequest`, `ValidatedRefreshToken`
   in `domain/authority/redemption.rs`, each implementing `MintAuthority`
   (the redemption proofs carry the twinned scope spellings; `HostBootstrap`
   stays verbatim); `RefreshFamilyWriter` (start a family, rotate; the two
   refresh-token inserts added to the guard); `TokenExchanger` in
   `domain/capabilities/oauth/` composing them with `AccessTokenMinter`.
   `TokenExchangeError` / `InvalidGrantReason` carry the specific reasons;
   `internal.rs` collapses them to the generic descriptions and logs the
   reason. The three exchange submodules and the HTTP-side minting are
   deleted; the `internal.rs` `IN_FLIGHT` entry is removed.
4. **`…-4-authorize-device` — the pre-auth front door.** `StandingGrantCoverage`
   proof (constructor requires a `Registered` verdict and full coverage);
   `RequestApprover::approve_for_code` takes a `CodeAuthority` enum
   (`OwnerDelegated` | `StandingGrant`) so the fast path reads as a named
   authority. `CodeAuthorizationStarter` reusing the consent
   `RegistrationContext`; `DeviceAuthorizer` with unique user-code generation;
   `AuthorizationStatusReader`; `Client::allows_scopes` replacing the two
   duplicated allowlist checks; `OAuthErrorKind` to domain. Remove the
   `authorize.rs` `IN_FLIGHT` entries and the `oauth/` guard exemption.
5. **`…-5-verification-session` — the rest, guards flip.** Token verification
   policy to `domain/token_verification.rs` behind a `RevocationCheck` port;
   `PublicKeysReader`; `Authenticated<F>` in `scope-capabilities-rust`;
   `SessionEnder` for logout; `client_allowed_scopes` delegating to domain.
   Remove every handler-guard exemption, widen its needles to all state fields,
   add a middleware guard. How-To rewrite for the proof pattern, Learnings Inbox
   entry, delete this file.

## Verification per PR

`./scripts/checks/rust.sh` (fmt, clippy `-D warnings`, nextest across the
workspace), `cargo test -p gatekeeper-rust` (unit + integration + OpenAPI
snapshot), `vp test openapi-drift`, `vp run lint:docs`. The integration suite
and the committed OpenAPI snapshot must be unchanged by every PR: only logic
moves, wire structs stay in `http/`.
