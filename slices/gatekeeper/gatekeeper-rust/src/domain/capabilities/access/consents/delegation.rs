//! The shared consent tail: the unconditional deny (mark denied + republish).

use crate::domain::gatekeeper_error::GatekeeperError;
use crate::domain::GatekeeperStore;
use crate::ports::PendingConsentPublisher;

/// Mark request `request_id` denied and republish the active consent head — the
/// shared tail of every deny path (explicit deny + a nothing-granted approve).
/// The head query spans both grant flows, so a code-flow deny moves it just as a
/// device deny does.
pub(super) fn deny_consent(
    store: &impl GatekeeperStore,
    publisher: &dyn PendingConsentPublisher,
    request_id: &str,
) -> Result<(), GatekeeperError> {
    store.deny_authorization_request(request_id)?;
    publisher.republish_active();
    Ok(())
}
