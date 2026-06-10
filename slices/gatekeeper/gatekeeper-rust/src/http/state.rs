use crate::db::GatekeeperStore;

/// Shared state threaded through every gatekeeper handler. Opaque to
/// callers outside the crate — the host receives one from
/// [`crate::setup_gatekeeper`] and passes it back into [`crate::gate`]
/// and [`crate::mint_host_owner_token`] without looking inside.
#[derive(Clone)]
pub struct AppState {
    pub(crate) store: GatekeeperStore,
}
