//! The **writers** — one per kind of privileged write, each method taking an
//! authority proof from [`crate::domain::authority`] as the price of
//! admission:
//!
//!  - [`RequestApprover`] — approve a pending request (the flow's own
//!    `approve` transition) and, for the code flow, issue its authorization
//!    code (under a [`CodeAuthority`]: the Owner's `DelegatedScopes` or a
//!    `StandingGrantCoverage`).
//!  - [`GrantRecorder`] — insert or widen the standing grant and, for a client
//!    trusted on first use, its registration (under `DelegatedScopes`).
//!  - [`AccessTokenMinter`] — read the active signing key, then sign a JWT
//!    under a `TokenEntitlement` proof.
//!  - [`RefreshFamilyWriter`] — start a refresh-token family or rotate a token
//!    into its successor (under a redemption proof).
//!  - [`BrowserSessionWriter`] — start a browser session (under a
//!    `RedeemedSameDeviceSignInCode` or a `ClaimedBrowserPairing`).
//!
//! A writer runs inside the caller's transaction, under its proof: it is built
//! over the scope's `GrantTx` (`within(tx)`), so what it writes lands with the
//! rest of the operation or not at all. It is not a gate in itself; the gate
//! is the proof each method demands. The source-guard tests below keep the
//! privileged calls from being made *around* the writers, and an approved or
//! claimed request from being built anywhere but its transitions and the row
//! it is read from.

mod access_token_minter;
mod browser_session_writer;
mod grant_recorder;
mod refresh_family_writer;
mod request_approver;

pub(crate) use access_token_minter::AccessTokenMinter;
pub(crate) use browser_session_writer::BrowserSessionWriter;
pub(crate) use grant_recorder::GrantRecorder;
pub(crate) use refresh_family_writer::RefreshFamilyWriter;
pub(crate) use request_approver::{CodeApproval, CodeAuthority, RequestApprover};

#[cfg(test)]
mod tests {
    use crate::domain::source_guard::{production_lines, relative_to, rs_files_under};

    /// The calls that grant authority — issuing a code, recording or widening
    /// a grant, widening a client registration, reading private key material
    /// to sign with, seeding a key, issuing a refresh token, starting a
    /// browser session. Each is written with a leading `.` so `tx.x(` matches
    /// while a differently named method that merely ends the same way
    /// (`has_active_signing_key(`) does not.
    const PRIVILEGED_CALLS: &[&str] = &[
        ".issue_authorization_code(",
        ".create_authorization_code_grant(",
        ".update_authorization_code_grant(",
        ".create_device_grant(",
        ".update_device_grant(",
        ".upsert_client(",
        ".active_signing_key(",
        ".insert_signing_key(",
        ".insert_refresh_token_family_row(",
        ".insert_refresh_token(",
        ".insert_browser_session(",
    ];

    /// Where a privileged call may legitimately appear: the writers themselves,
    /// the `SQLite` adapter and port definition that implement and declare the
    /// methods, the in-memory fake, and the boot-time seeding (the signing-key
    /// seed and the essential client rows come from configuration, not from a
    /// delegation).
    const ALLOWED_PREFIXES: &[&str] = &[
        "domain/capabilities/writers/",
        "db/",
        "domain/grant_store/",
        "domain/test_fake/",
        "seeding.rs",
    ];

    /// The authorization-request entity, whose transitions build the states.
    const ENTITY: &str = "domain/authorization_request/";
    /// The code request's row conversion, which reads its state back from
    /// its columns.
    const CODE_ROW_CONVERSION: &str = "db/authorization_requests/code_request_row.rs";
    /// The device request's and browser pairing's row conversion, which
    /// reads their states back from their columns.
    const USER_CODE_ROW_CONVERSION: &str = "db/authorization_requests/user_code_request_row.rs";
    /// The writers, which call the approve transitions under a proof.
    const WRITERS: &str = "domain/capabilities/writers/";
    /// The in-memory fake and its fixtures, which arrange rows for tests.
    const TEST_FAKE: &str = "domain/test_fake/";

    /// One way to make an authorization request approved or claimed: the
    /// text that does it, and the files it may appear in.
    struct ApprovalConstruction {
        /// The text, matched at the start of a name when it starts with a
        /// letter, so `ResolvedCodeRequest {` is not `CodeRequest {`.
        needle: &'static str,
        /// The path prefixes under `src/` it may appear in.
        allowed: &'static [&'static str],
        /// Whether a match arm's pattern may name it: a pattern (the text
        /// before a line's `=>`) reads a state, it doesn't build one.
        read_in_match_arms: bool,
    }

    /// What makes an authorization request approved or claimed, and where
    /// each may appear. An approved request is what a code, a device grant or
    /// a paired session is issued against, so only these may build one:
    ///
    /// - each flow's `approve` transition, called only by the writers, under
    ///   the proof they demand;
    /// - each polled flow's `claim` transition, called only by the writers and
    ///   by the two authority proofs whose single-use redemption it is
    ///   (`ConsumedDeviceRequest` and `ClaimedBrowserPairing`);
    /// - the `Approved(` and `Claimed(` states, built only by the entity's
    ///   transitions and the flow's row conversion that reads them back (any
    ///   file may match on them);
    /// - a flow's struct literal (`CodeRequest {`, …), which could carry
    ///   another request's state over, built only there too.
    const APPROVAL_CONSTRUCTIONS: &[ApprovalConstruction] = &[
        ApprovalConstruction {
            needle: ".approve(",
            allowed: &[WRITERS, TEST_FAKE],
            read_in_match_arms: false,
        },
        ApprovalConstruction {
            needle: ".claim(",
            allowed: &[
                WRITERS,
                TEST_FAKE,
                "domain/authority/redemption.rs",
                "domain/authority/browser_pairing.rs",
            ],
            read_in_match_arms: false,
        },
        ApprovalConstruction {
            needle: "Approved(",
            allowed: &[
                ENTITY,
                CODE_ROW_CONVERSION,
                USER_CODE_ROW_CONVERSION,
                TEST_FAKE,
            ],
            read_in_match_arms: true,
        },
        ApprovalConstruction {
            needle: "Claimed(",
            allowed: &[ENTITY, USER_CODE_ROW_CONVERSION, TEST_FAKE],
            read_in_match_arms: true,
        },
        ApprovalConstruction {
            needle: "CodeRequest {",
            allowed: &[ENTITY, CODE_ROW_CONVERSION, TEST_FAKE],
            read_in_match_arms: false,
        },
        ApprovalConstruction {
            needle: "DeviceRequest {",
            allowed: &[ENTITY, USER_CODE_ROW_CONVERSION, TEST_FAKE],
            read_in_match_arms: false,
        },
        ApprovalConstruction {
            needle: "PairingRequest {",
            allowed: &[ENTITY, USER_CODE_ROW_CONVERSION, TEST_FAKE],
            read_in_match_arms: false,
        },
    ];

    /// Whether `line` holds `needle`, at the start of a name when the needle
    /// starts with one. A type named where a type goes, after `->`, `for` or
    /// `impl`, builds nothing.
    fn holds(line: &str, needle: &str) -> bool {
        let starts_a_name = needle.starts_with(|c: char| c.is_alphabetic());
        line.match_indices(needle).any(|(at, _)| {
            if !starts_a_name {
                return true;
            }
            let before = &line[..at];
            let mid_name = before
                .chars()
                .next_back()
                .is_some_and(|c| c.is_alphanumeric() || c == '_' || c == '<');
            let names_a_type = before.trim_end().ends_with("->")
                || before
                    .split_whitespace()
                    .next_back()
                    .is_some_and(|word| word == "for" || word == "impl");
            !mid_name && !names_a_type
        })
    }

    /// Every privileged call or approval construction in the production
    /// lines of `source`, the file at `relative` under `src/`, that its
    /// location doesn't allow, as `relative:line needle`.
    fn violations(relative: &str, source: &str) -> Vec<String> {
        let mut found = Vec::new();
        let privileged_calls_allowed = ALLOWED_PREFIXES
            .iter()
            .any(|prefix| relative.starts_with(prefix));
        for (n, line) in production_lines(source) {
            if !privileged_calls_allowed {
                for needle in PRIVILEGED_CALLS {
                    if holds(&line, needle) {
                        found.push(format!("{relative}:{n} {needle}"));
                    }
                }
            }
            for construction in APPROVAL_CONSTRUCTIONS {
                if construction
                    .allowed
                    .iter()
                    .any(|prefix| relative.starts_with(prefix))
                {
                    continue;
                }
                let built_in = match line.find("=>") {
                    Some(arrow) if construction.read_in_match_arms => &line[arrow + 2..],
                    _ => line.as_str(),
                };
                if holds(built_in, construction.needle) {
                    found.push(format!("{relative}:{n} {}", construction.needle));
                }
            }
        }
        found
    }

    /// Default-safety guard: a privileged store method is called only inside a
    /// writer (or the adapter / port / fake / seeding files that define it),
    /// and an approved or claimed request is built only where
    /// [`APPROVAL_CONSTRUCTIONS`] allows. A new flow that reaches around the
    /// writers — and so around the proof its method would have demanded —
    /// fails here. Comments and unit-test modules are skipped (see
    /// [`production_lines`]): prose may name the methods, and a test may
    /// plant rows to arrange its state.
    #[test]
    fn privileged_store_calls_happen_only_in_writers() {
        let src = std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/src"));
        let mut checked = 0;
        let mut found = Vec::new();
        for path in rs_files_under(src).expect("enumerate src") {
            let relative = relative_to(&path, src).expect("enumerated under src");
            let source =
                std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {relative}: {e}"));
            found.extend(violations(&relative, &source));
            checked += 1;
        }
        assert!(
            found.is_empty(),
            "privileged calls or approval constructions outside where they belong; obtain the \
             authority proof and go through `domain::capabilities::writers`: {found:#?}",
        );
        assert!(
            checked >= 40,
            "only {checked} source files enumerated — did src/ move?",
        );
    }

    /// The guard trips on every approval construction outside its allowed
    /// files, and on none inside them; a match arm's pattern reading a state
    /// doesn't trip it, nor does a name that merely ends like a needle.
    #[test]
    fn the_guard_catches_every_approval_construction_outside_its_files() {
        const FLOW: &str = "domain/capabilities/oauth/flow.rs";
        for construction in APPROVAL_CONSTRUCTIONS {
            let needle = construction.needle;
            let receiver = if needle.starts_with('.') {
                "request"
            } else {
                "flow::"
            };
            let built = format!("fn f() {{\n    let x = {receiver}{needle}y;\n}}\n");
            assert_eq!(
                violations(FLOW, &built).len(),
                1,
                "{needle} outside its files"
            );
            let built_in_an_arm = format!("fn f() {{\n    a => {receiver}{needle}y,\n}}\n");
            assert_eq!(
                violations(FLOW, &built_in_an_arm).len(),
                1,
                "{needle} built in a match arm"
            );
            let read_in_an_arm = format!("fn f() {{\n    {receiver}{needle}y) => a,\n}}\n");
            assert_eq!(
                violations(FLOW, &read_in_an_arm).is_empty(),
                construction.read_in_match_arms,
                "{needle} in a match arm's pattern"
            );
            for prefix in construction.allowed {
                let relative = if prefix.ends_with(".rs") {
                    (*prefix).to_owned()
                } else {
                    format!("{prefix}inner.rs")
                };
                assert!(
                    violations(&relative, &built).is_empty(),
                    "{needle} in {relative}"
                );
            }
        }
        assert!(violations(
            FLOW,
            "fn f() -> CodeRequest {\n    let r = ResolvedCodeRequest {\n        a: NotApproved(1),\n    };\n}\nimpl Polled for DeviceRequest {\n}\n",
        )
        .is_empty());
        assert_eq!(
            violations(FLOW, "fn f() {\n    tx.insert_browser_session(&s);\n}\n").len(),
            1
        );
    }
}
