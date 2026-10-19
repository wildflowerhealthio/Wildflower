//! The **writers** — one per kind of privileged write, each method taking an
//! authority proof from [`crate::domain::authority`] as the price of
//! admission:
//!
//!  - [`RequestApprover`] — approve a pending request (the request's own
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
//! is the proof each method demands. The source-guard test below keeps the
//! privileged calls from being made *around* the writers.

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

    /// The calls that grant authority — approving a request (its entity
    /// transitions, one per kind: [`AuthorizationRequest::approve_code`],
    /// [`AuthorizationRequest::approve_device`],
    /// [`AuthorizationRequest::approve_pairing`]), issuing a code,
    /// recording or widening a grant, widening a client registration, reading
    /// private key material to sign with, seeding a key, issuing a refresh
    /// token, starting a browser session. Each is written with a leading `.`
    /// so `request.x(` and `tx.x(` match while a differently named method
    /// that merely ends the same way (`has_active_signing_key(`) does not.
    ///
    /// [`AuthorizationRequest::approve_code`]: crate::domain::authorization_request::AuthorizationRequest::approve_code
    /// [`AuthorizationRequest::approve_device`]: crate::domain::authorization_request::AuthorizationRequest::approve_device
    /// [`AuthorizationRequest::approve_pairing`]: crate::domain::authorization_request::AuthorizationRequest::approve_pairing
    const PRIVILEGED_CALLS: &[&str] = &[
        ".approve_code(",
        ".approve_device(",
        ".approve_pairing(",
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
    /// delegation). The entity defining the approve transitions declares them
    /// (`fn approve_code(`, …) and calls them nowhere.
    const ALLOWED_PREFIXES: &[&str] = &[
        "domain/capabilities/writers/",
        "db/",
        "domain/grant_store/",
        "domain/test_fake/",
        "seeding.rs",
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
        for path in rs_files_under(src).expect("enumerate src") {
            let relative = relative_to(&path, src).expect("enumerated under src");
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
                    assert!(
                        !line.contains(needle),
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
}
