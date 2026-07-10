//! Configuration types the caller hands to [`crate::setup_fhir_r4`].

use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct EmrConfig {
    pub log_level: String,
    pub db_file_path: PathBuf,
    /// Directory containing the FHIR R4 `SearchParameter` spec bundle
    /// (`search-parameters-r4.json`) HFS loads at startup to index searches.
    ///
    /// The bundle is a deployed **asset**, not embedded in the binary: the host
    /// ships it as a bundled resource and points this at that directory (in the
    /// Tauri app, `<resource_dir>/fhir-search-params` in release, the vendored
    /// `emr-rust/assets` tree in dev). HFS reads it read-only via its backend
    /// `data_dir`. [`crate::setup_fhir_r4`] fails fast if the bundle is missing,
    /// because an absent bundle silently degrades every search to the ~9-param
    /// minimal fallback. See this crate's `docs/Capability Statement.md`.
    pub search_parameter_data_dir: PathBuf,
    /// JWKS endpoint HFS fetches signing keys from to validate inbound
    /// Bearer JWTs. `Some(url)` enables HFS auth (every FHIR request must
    /// carry a token, scopes enforced); `None` leaves HFS open and relies
    /// on whatever middleware wraps this router from outside (e.g. the
    /// Tauri host's gatekeeper gating layer). Validated `iss` =
    /// [`shared_structures_rust::CANONICAL_ISSUER`]; see
    /// `docs/Origins/Explanation.md`.
    pub jwks_url: Option<String>,
}
