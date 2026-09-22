//! The **writers** — one capability per privileged store write, each method
//! taking an authority proof from [`crate::domain::authority`] as the price of
//! admission:
//!
//!  - [`RequestApprover`] — approve a pending request and, for the code flow,
//!    issue its authorization code (under `DelegatedScopes`).
//!  - [`GrantRecorder`] — insert or widen the standing grant and, for a client
//!    trusted on first use, its registration, in one transaction (under
//!    `DelegatedScopes`).
//!  - [`AccessTokenMinter`] — read the active signing key and mint a JWT (under
//!    a `MintAuthority` proof).
//!
//! A writer is a borrowed view over a store, not a gate in itself; the gate is
//! the proof each method demands. The source-guard test below keeps the
//! privileged store methods from being called *around* the writers.

mod access_token_minter;
mod grant_recorder;
mod request_approver;

pub(crate) use access_token_minter::{AccessTokenMinter, MintRequest, TokenIssuanceError};
pub(crate) use grant_recorder::{GrantRecorder, RegistrationWrite};
pub(crate) use request_approver::{CodeApproval, DeviceApproval, RequestApprover};

#[cfg(test)]
mod tests {
    use crate::domain::source_guard::{production_lines, relative_to, rs_files_under};

    /// The store methods that grant authority — approving a request, issuing a
    /// code, recording or widening a grant, widening a client registration,
    /// reading private key material to sign with, seeding a key. Each is written
    /// with a leading `.` so `store.x(` and `tx.x(` match while a differently
    /// named method that merely ends the same way (`has_active_signing_key(`)
    /// does not.
    const PRIVILEGED_CALLS: &[&str] = &[
        ".approve_authorization_request(",
        ".issue_authorization_code(",
        ".create_authorization_code_grant(",
        ".update_authorization_code_grant(",
        ".create_device_grant(",
        ".update_device_grant(",
        ".upsert_client(",
        ".active_signing_key(",
        ".insert_signing_key(",
    ];

    /// Where a privileged call may legitimately appear: the writers themselves,
    /// the `SQLite` adapter and port definition that implement and declare the
    /// methods, the in-memory fake, and the boot-time seeding (the signing-key
    /// seed and the first-party client row come from configuration, not from a
    /// delegation — the `HostBootstrap` proof names that exception).
    const ALLOWED_PREFIXES: &[&str] = &[
        "domain/capabilities/writers/",
        "db/",
        "domain/gatekeeper_store/",
        "domain/test_fake/",
        "seeding.rs",
    ];

    /// Call sites that still reach a privileged method directly and are moved
    /// behind a writer by a later PR in the chain. Listed by file with the
    /// method, so the remaining work is visible here rather than hidden by a
    /// blanket exemption. Remove each entry as its PR lands.
    const IN_FLIGHT: &[(&str, &str)] = &[
        // PR 3 (token exchange): minting moves behind `AccessTokenMinter`.
        ("http/routes/oauth/internal.rs", ".active_signing_key("),
        // PR 4 (authorize): the pre-approved fast path moves behind
        // `RequestApprover` under a `StandingGrantCoverage` proof.
        (
            "http/routes/oauth/authorize.rs",
            ".issue_authorization_code(",
        ),
        (
            "http/routes/oauth/authorize.rs",
            ".approve_authorization_request(",
        ),
    ];

    /// Default-safety guard: a privileged store method is called only inside a
    /// writer (or the adapter / port / fake / seeding files that define it). A
    /// new flow that reaches around the writers — and so around the proof its
    /// method would have demanded — fails here. Comments and unit-test modules
    /// are skipped (see [`production_lines`]): prose may name the methods, and
    /// a test may plant rows to arrange its state.
    #[test]
    fn privileged_store_calls_happen_only_in_writers() {
        let src = std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/src"));
        let mut checked = 0;
        for path in rs_files_under(src) {
            let relative = relative_to(&path, src);
            if ALLOWED_PREFIXES
                .iter()
                .any(|prefix| relative.starts_with(prefix))
            {
                continue;
            }
            let source =
                std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {relative}: {e}"));
            for (n, line) in production_lines(&source) {
                for needle in PRIVILEGED_CALLS {
                    if !line.contains(needle) {
                        continue;
                    }
                    let in_flight = IN_FLIGHT
                        .iter()
                        .any(|(file, method)| *file == relative && method == needle);
                    assert!(
                        in_flight,
                        "{relative}:{n} calls the privileged store method `{needle}` outside a \
                         writer; obtain the authority proof and go through \
                         `domain::capabilities::writers`",
                    );
                }
            }
            checked += 1;
        }
        assert!(
            checked >= 40,
            "only {checked} source files enumerated — did src/ move?",
        );
    }

    /// The in-flight list must shrink, never rot: every entry must still match a
    /// real call, so a finished migration can't leave a stale exemption that a
    /// future regression would hide behind.
    #[test]
    fn every_in_flight_exemption_still_names_a_real_call() {
        let src = std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/src"));
        for (file, method) in IN_FLIGHT {
            let source = std::fs::read_to_string(src.join(file))
                .unwrap_or_else(|e| panic!("in-flight exemption names a missing file {file}: {e}"));
            let still_called = production_lines(&source).any(|(_, line)| line.contains(method));
            assert!(
                still_called,
                "{file} no longer calls `{method}`; remove its IN_FLIGHT exemption",
            );
        }
    }
}
