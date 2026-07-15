//! Client actions over the [`GatekeeperStore`] port.

use crate::domain::client::Client;
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::domain::GatekeeperStore;

/// Look up a registered client by id — a thin relay; the callers decide how a
/// missing client renders (a local HTML page at `/authorize`, a 401 at
/// `/token`, a display-name fallback on the consent surfaces), so the mapping
/// stays HTTP-flow logic in the handlers.
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if the store read fails.
pub(crate) fn client_by_id(
    store: &impl GatekeeperStore,
    client_id: &str,
) -> Result<Option<Client>, GatekeeperError> {
    store.client_by_id(client_id)
}
