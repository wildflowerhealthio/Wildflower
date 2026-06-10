use crate::origin::SharedOriginProvider;
use crate::store::GatekeeperStore;

#[derive(Clone)]
pub struct AppState {
    pub store: GatekeeperStore,
    pub origin: SharedOriginProvider,
}
