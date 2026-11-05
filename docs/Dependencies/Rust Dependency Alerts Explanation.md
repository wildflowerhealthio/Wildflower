# Rust Dependency Alerts Explanation

Two checks report on the Rust dependency tree. This doc explains how they differ, the one pin that holds most of that tree in place, and each open alert the pin blocks: what the advisory is, whether it reaches us, and what unblocks it.

## Two reports, two databases

**cargo-deny** runs on every PR that touches Rust (the `rust-deny` job, "Rust Dependency Check", in `.github/workflows/ci.yml`) against the [RustSec](https://rustsec.org) database. [deny.toml](../../deny.toml) configures it: a matching advisory fails the job unless its id is in `ignore`, and every entry there carries a comment saying why the risk is tolerable and what would let it go. cargo-deny reports `advisory-not-detected` for an ignore that no longer matches anything, which is the cue to delete the entry. It also refuses yanked crates. Run it locally with `cargo deny check advisories` (`cargo install cargo-deny`).

**Dependabot alerts**, on the repository's Security tab, come from the [GitHub Advisory Database](https://github.com/advisories) and match the versions in `Cargo.lock`. That database is broader than RustSec, so the alert list can be longer than the `ignore` list: an advisory RustSec carries as a vulnerability fails cargo-deny, one RustSec carries as informational (an "unsound" entry, say) or not at all leaves cargo-deny green. Nothing in the repo configures alerts; `.github/dependabot.yml` configures version-update PRs only. An alert closes on its own once the lockfile stops matching its range. Until then it stays open, or is dismissed on GitHub with a reason and a comment.

## The helios serde pin

The helios crates behind the FHIR server (`helios-rest`, `-persistence`, `-auth`, `-fhir`, `-ui` and `-audit`, exact-pinned in [fhir-r4-rust](../../apps/host/wildflower-server/fhir-r4-rust/Cargo.toml) and [wildflower-server-rust](../../apps/host/wildflower-server/wildflower-server-rust/Cargo.toml)) declare `serde = "=1.0.224"` and `serde_json = "=1.0.144"`. Cargo resolves one `serde` 1.x for the whole workspace, and `serde` pins its `serde_core` exactly, so every crate whose fix needs a newer `serde` or `serde_core` is held at the last version that accepts 1.0.224. Upstream [HeliosSoftware/hfs](https://github.com/HeliosSoftware/hfs/blob/main/Cargo.toml) carries the same pins on `main`, and no release has relaxed them.

The symptom: `cargo update -p <crate>` leaves the crate `Unchanged` although `--verbose` shows a newer version available. `cargo update -p <crate> --precise <version>` then names the pin in its conflict message.

What unblocks it: a helios release that declares `serde = "1"`, or a `[patch.crates-io]` fork with the pins relaxed, as the workspace already does for `tauri-plugin-background-service`. #1072 weighs the two, because the same pin holds Tauri at 2.11 (`tauri` 2.12 → `tauri-build` 2.7 → `cargo_toml` 1.0 → `serde` ≥ 1.0.228). One such release clears every serde row below at once: bump the helios pins in lockstep, `cargo update`, and the alerts close as the lockfile moves.

## Open alerts that cannot move

| Alert                                                                          | Crate in `Cargo.lock`                                                             | Fixed in | Why it cannot move                                                                                                                                                                    |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#26](https://github.com/wildflowerhealthio/Wildflower/security/dependabot/26) | `jsonwebtoken` 10.2.0 (ours, authorization-server-rust) and 9.3.1 (`helios-auth`) | 10.3.0   | 10.3 and later need `serde ^1.0.228`. `helios-auth` asks for `jsonwebtoken ^9`, so its copy stays even once serde is free, until helios moves to 10.                                  |
| [#51](https://github.com/wildflowerhealthio/Wildflower/security/dependabot/51) | `serde_with` 3.14.1, via `tauri-utils` 2.10 (`tauri` 2.11)                        | 3.21.0   | 3.21 and later need `serde_core ^1.0.225`.                                                                                                                                            |
| [#25](https://github.com/wildflowerhealthio/Wildflower/security/dependabot/25) | `glib` 0.18.5, via `gtk` 0.18 (`tauri` and `wry` on Linux)                        | 0.20.0   | Not the serde pin. `glib` 0.20 belongs to the gtk4 generation of the gtk-rs bindings; the gtk3 bindings Tauri 2 is built on end at 0.18. It moves with a Tauri release built on gtk4. |

None of the three reaches us:

- **jsonwebtoken (#26), type confusion in claim validation.** A registered claim given the wrong JSON type (a string `exp`, say) is skipped rather than rejected, unless the claim is in `required_spec_claims`. Our verifier ([access_token/verify.rs](../../apps/host/wildflower-server/authorization-server-rust/src/domain/access_token/verify.rs)) builds `Validation::new(Algorithm::RS256)`, which keeps `exp` required by default, sets issuer and audience, and does not validate `nbf`. Claims are read only from a token whose RS256 signature verifies against one of our own signing keys, and our minting writes numeric claims, so a malformed claim cannot arrive in a token the verifier accepts. The `helios-auth` copy checks the same tokens behind the same signature requirement.
- **serde_with (#51), panic in the `KeyValueMap` serializer** on an empty entry. `tauri-utils` is the only dependent, and it uses `serde_with` for `skip_serializing_none` alone; nothing in the tree serializes through `KeyValueMap`.
- **glib (#25), unsound `VariantStrIter`.** A GVariant string-array iterator wrote through a shared reference; in optimised builds the result is a NULL dereference, a crash rather than a usable primitive. Only the Linux desktop build links `glib`, through `gtk` and `webkit2gtk`, and no Wildflower crate calls it directly.

## When another alert cannot move

Check the blocker with `cargo update -p <crate> --precise <fixed version>`, and read the advisory for the path it needs. If the risk is tolerable, dismiss the alert on the Security tab (or with `gh api -X PATCH repos/wildflowerhealthio/Wildflower/dependabot/alerts/<n> -f state=dismissed -f dismissed_reason=tolerable_risk -f dismissed_comment='…'`) with a comment that points here, and add it to the table above. If RustSec carries the advisory too, cargo-deny fails as well: add its id to `ignore` in `deny.toml` with the same reasoning in the comment, and drop the entry when cargo-deny reports `advisory-not-detected`.
