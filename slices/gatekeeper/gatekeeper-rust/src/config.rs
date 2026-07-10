use url::Url;

#[derive(Debug, Clone)]
pub struct GatekeeperConfig {
    /// The HTTP-only loopback origin the embedded API server binds to, e.g.
    /// `http://127.0.0.1:8080/`, as a typed [`Url`]. The loopback base URL
    /// [`served_base_url_for`](crate::http::served_base_url_for) returns when a
    /// request carries no public-origin header (consumers then take its bare
    /// origin via [`shared_structures_rust::origin_string`]).
    pub loopback_base_url: Url,

    /// The host's granted-scope wire strings — seeded as the first-party
    /// client's `allowed_scopes` and minted into the boot-time host owner token.
    /// The live Tauri app sources these from `tauri-shared-config.json` (the
    /// single source shared with the TS shell); standalone/test builds use
    /// [`crate::default_local_granted_scopes`]. Must cover every
    /// [`crate::WILDFLOWER_WIDEST_SCOPES`] entry or the host token can't pass the
    /// `/access/*` owner gate (asserted in [`crate::setup_gatekeeper`]).
    pub granted_scopes: Vec<String>,

    /// The `client_id` of the host's first-party OAuth client — seeded as the
    /// first-party client row, minted into the boot-time host owner token, and
    /// matched against a `/token` request's presented `client_id` to grant
    /// first-party treatment. The live Tauri app sources this from
    /// `tauri-shared-config.json` (the single source shared with the TS shell);
    /// standalone/test builds use [`crate::default_first_party_client_id`].
    pub first_party_client_id: String,
}
