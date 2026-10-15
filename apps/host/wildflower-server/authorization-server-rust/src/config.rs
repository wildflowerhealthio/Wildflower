use url::Url;
use wildflowerhealthio_shared_structures::authorization_app::AuthorizationAppBase;
use wildflowerhealthio_shared_structures::launcher::LauncherBase;

#[derive(Debug, Clone)]
pub struct AuthorizationServerConfig {
    /// The HTTP-only loopback origin the embedded API server binds to, e.g.
    /// `http://127.0.0.1:8080/`, as a typed [`Url`]. The loopback base URL
    /// [`served_base_url_for`](wildflowerhealthio_shared_structures::served_origin::served_base_url_for) returns when a
    /// request carries no public-origin header (consumers then take its bare
    /// origin via [`wildflowerhealthio_shared_structures::origin_string`]).
    pub loopback_base_url: Url,

    /// The server's origin, `https://<domain>`, as a typed [`Url`]. Every token
    /// this server mints carries its bare origin (via
    /// [`wildflowerhealthio_shared_structures::origin_string`]) as both `iss` and `aud`, and
    /// the bearer gates accept only tokens that do, whichever origin a request
    /// was served on. See `docs/Origins/Explanation.md`.
    pub server_origin: Url,

    /// The scopes the host app's client may be granted, as wire strings —
    /// seeded as its `allowed_scopes`. The Owner's own authority is
    /// [`crate::OWNER_SCOPES`], not this. The live Tauri app sources these from
    /// `tauri-shared-config.json`; standalone/test builds use
    /// [`crate::default_host_app_client_scopes`].
    pub host_app_client_scopes: Vec<String>,

    /// The `client_id` of the Wildflower host app's OAuth client — seeded as
    /// the host app's client row and matched against a `/token` request's
    /// presented `client_id` to hold it to its fixed registration. The live
    /// Tauri app sources this from `tauri-shared-config.json`; standalone/test
    /// builds use [`crate::default_wildflower_host_app_client_id`].
    pub wildflower_host_app_client_id: String,

    /// The `client_id` of the FHIR server's web UI (`helios-ui`), which signs
    /// its users in here with the authorization-code flow. Seeded on every boot
    /// with `{server_origin}/ui/callback` as its one redirect URI (see
    /// [`crate::seeding`]). The host owns the id and hands the same one to
    /// `fhir-r4-rust`, which sends it as the UI's `client_id`.
    pub fhir_ui_client_id: String,

    /// The hosted launcher the device-flow `verification_uri` and logout's
    /// landing live on (see [`LauncherBase`]). The live Tauri app sources it
    /// from `tauri-shared-config.json`.
    pub launcher_base: LauncherBase,

    /// The hosted Wildflower Authorization app (see [`AuthorizationAppBase`]):
    /// besides the launcher, this server's own paths and the pages below, a
    /// place `/oauth/sign-in` may send a browser next. The live Tauri app
    /// sources it from `tauri-shared-config.json`.
    pub authorization_app_base: AuthorizationAppBase,

    /// The page the host opens this server's launches in, its own launcher,
    /// which a browser signed in at `/oauth/sign-in` may be sent on to. The
    /// live Tauri app sources it from the server's record.
    pub launcher_url: Url,

    /// The page the host opens this server's Authorization app at, which a
    /// browser signed in at `/oauth/sign-in` may be sent on to. The live Tauri
    /// app sources it from the server's record.
    pub authorization_url: Url,
}
