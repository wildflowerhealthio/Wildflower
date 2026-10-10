//! The shared consent tail: the unconditional deny (mark denied + republish).

use crate::domain::gatekeeper_error::GatekeeperError;
use crate::domain::GatekeeperStore;
use crate::ports::PendingConsentPublisher;

/// Mark request `request_id` denied and republish the active consent head — the
/// shared tail of every deny path (explicit deny + a nothing-granted approve).
/// The head query spans both grant flows, so a code-flow deny moves it just as a
/// device deny does.
///
/// The deny applies only to a still-pending request: when another surface
/// decided it first (or it expired) between the caller's load and this write,
/// nothing changes and the flow's own not-found error (`make_not_found`) is
/// returned, as an approval that loses the same race does.
pub(super) fn deny_consent(
    store: &impl GatekeeperStore,
    publisher: &dyn PendingConsentPublisher,
    request_id: &str,
    make_not_found: impl FnOnce() -> GatekeeperError,
) -> Result<(), GatekeeperError> {
    let denied = store.deny_authorization_request(request_id)?;
    publisher.republish_active();
    if denied {
        Ok(())
    } else {
        Err(make_not_found())
    }
}
