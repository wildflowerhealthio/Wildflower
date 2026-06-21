//! Configuration types the caller hands to [`crate::setup_fhir_r4`].

use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct EmrConfig {
    pub log_level: String,
    pub db_file_path: PathBuf,
    /// JWKS endpoint HFS fetches signing keys from to validate inbound
    /// Bearer JWTs. `Some(url)` enables HFS auth (every FHIR request must
    /// carry a token, scopes enforced); `None` leaves HFS open and relies
    /// on whatever middleware wraps this router from outside (e.g. the
    /// Tauri host's gatekeeper gating layer). The expected `iss` is
    /// pinned to [`shared_structures_rust::CANONICAL_ISSUER`] — same value
    /// gatekeeper writes into every minted token.
    pub jwks_url: Option<String>,
}
