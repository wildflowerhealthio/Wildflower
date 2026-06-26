#[derive(Debug, Clone)]
pub struct GatekeeperConfig {
    /// The HTTP-only loopback origin the embedded API server binds to, e.g.
    /// `http://127.0.0.1:8080`. The fallback
    /// [`served_origin_for`](crate::http::served_origin_for) returns when a
    /// request carries no public-origin header.
    pub loopback_origin: String,

    /// The host's granted-scope wire strings — seeded as the first-party
    /// client's `allowed_scopes` and minted into the boot-time host owner token.
    /// The live Tauri app sources these from `tauri-shared-config.json` (the
    /// single source shared with the TS shell); standalone/test builds use
    /// [`crate::default_local_granted_scopes`]. Must cover every
    /// [`crate::WILDFLOWER_WIDEST_SCOPES`] entry or the host token can't pass the
    /// `/access/*` owner gate (asserted in [`crate::setup_gatekeeper`]).
    pub granted_scopes: Vec<String>,
}
