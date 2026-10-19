# Writers

{{#covers apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/mod.rs}}

Some writes hand out authority: approving a request, issuing an authorization code, recording or widening a standing grant, widening an app's registration, reading a private key to sign a token with, issuing a refresh token, starting a browser session. **Every one of them happens in a writer, and every writer method takes an [authority proof](<Authority Explanation.md>) as the price of admission.** A proof can only be had from its one constructor, which runs the check it stands for, so a write that holds the proof is a write whose check ran.

A writer is not a gate of its own. It is built over the caller's open scope (`within(tx)`), so what it writes lands with the rest of the operation or not at all, and the gate is the proof each method demands. The capabilities above decide what is being done and obtain the proof; the [Grant Store](<Grant Store Explanation.md>) below holds the rows. The writers sit between them: the only code that may make the privileged store calls.

| Writer                                                                    | The write                                                                              | The proof it demands                                                  |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| [Request Approver](<Writers/Request Approver Explanation.md>)             | Approve a pending request; for the code flow, issue its code.                          | `DelegatedScopes`, or for a code either it or `StandingGrantCoverage` |
| [Grant Recorder](<Writers/Grant Recorder Explanation.md>)                 | Create or widen a standing grant, and an app's registration when trusted on first use. | `DelegatedScopes`                                                     |
| [Refresh Family Writer](<Writers/Refresh Family Writer Explanation.md>)   | Start a refresh-token family, or rotate a token into its successor.                    | `GrantRedemption`, or `ValidatedRefreshToken`                         |
| [Access Token Minter](<Writers/Access Token Minter Explanation.md>)       | Read the active signing key and sign an access token.                                  | `TokenEntitlement`                                                    |
| [Browser Session Writer](<Writers/Browser Session Writer Explanation.md>) | Start a browser session.                                                               | `RedeemedSameDeviceSignInCode`, or `ClaimedBrowserPairing`            |

## `privileged_store_calls_happen_only_in_writers`

**A privileged store call outside the writers fails the unit tests.** A new flow that reached around a writer would reach around the proof the writer's method demands, so the rule is pinned by a source guard rather than left to review.

The guarded calls are the request's three approve transitions, code issuance, every grant create and update, the client upsert, reading the active signing key, inserting a signing key, inserting a refresh family or token, and inserting a browser session. Rebuilding a request from its stored parts ([`restore`](<Domain/Authorization Request Explanation.md#restore>)) is guarded too: it can make an approved request from nothing, so only the store adapter may call it. Each needle starts with `.` or `::`, so a call matches whatever it is called on, while another method whose name merely ends the same way does not.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/mod.rs tests::PRIVILEGED_CALLS}}

The calls may appear in the writers, in the store adapter and the port that implement and declare them, in the in-memory test fake, and in boot-time seeding, whose signing key and essential client rows come from configuration rather than from anyone's delegation.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/mod.rs tests::ALLOWED_PREFIXES}}

The guard walks every `.rs` file under `src/`, skips the allowed ones, and scans the rest line by line for the needles. It scans production code only ([`production_lines`](<Domain/Source Guards Explanation.md#production_lines>)): comments and string literals are blanked out, and test-only items are skipped, so prose may name the methods and a unit test may plant rows to arrange its state. A floor on the number of files checked catches the guard walking an empty tree.

{{#code apps/host/wildflower-server/authorization-server-rust/src/domain/capabilities/writers/mod.rs tests::privileged_store_calls_happen_only_in_writers}}

## The writers

- [Request Approver](<Writers/Request Approver Explanation.md>): approves pending requests of all three kinds, and issues the code-flow request's authorization code, bounded by the requesting browser's session.
- [Grant Recorder](<Writers/Grant Recorder Explanation.md>): records the standing grant an approval leaves behind, and registers or widens an app trusted on first use.
- [Refresh Family Writer](<Writers/Refresh Family Writer Explanation.md>): starts a refresh-token family for a redemption that earns one, and rotates a refresh token, expiring the family on a replay.
- [Access Token Minter](<Writers/Access Token Minter Explanation.md>): signs an access token carrying exactly an entitlement's claims.
- [Browser Session Writer](<Writers/Browser Session Writer Explanation.md>): stores the Owner session a sign-in code starts, or the approved session a pairing starts.
