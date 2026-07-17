//! Shared consent tails: the unconditional deny (mark denied + republish) and the
//! approver-authority clamp ("can't delegate more than you hold").

use scopes_rust::{Grant, Scope};

use crate::domain::gatekeeper_error::GatekeeperError;
use crate::domain::GatekeeperStore;
use crate::ports::DeviceUserCodePublisher;

/// Mark request `request_id` denied and republish the active device-consent head
/// — the shared tail of every deny path (explicit deny + a nothing-granted
/// approve). Code-flow denies are no-ops against the device-only query, so this
/// is called unconditionally.
pub(super) fn deny_consent(
    store: &impl GatekeeperStore,
    publisher: &dyn DeviceUserCodePublisher,
    request_id: &str,
) -> Result<(), GatekeeperError> {
    store.deny_authorization_request(request_id)?;
    publisher.republish_active();
    Ok(())
}

/// Reject (with a `403`-rendering error, NOT a silent narrowing) any **resource**
/// scope in `granted_scopes` the `approver`'s own grant doesn't authorize — "an
/// approver can't delegate more permission than they hold". Only FHIR/Wildflower
/// resource scopes are checked; identity/session markers (`openid`,
/// `offline_access`, …) pass through. Authority is checked across both the SMART
/// v1-word and v2-letter spellings via [`Scope::as_alternate_canonical_form`],
/// the same twinning the token minter applies, which bridges the spelling without
/// widening the underlying interactions.
pub(super) fn ensure_approver_covers(
    granted_scopes: &[String],
    approver: &Grant,
) -> Result<(), GatekeeperError> {
    let approver_authority = Grant::new(
        approver
            .scopes
            .iter()
            .flat_map(|held| [Some(held.clone()), held.as_alternate_canonical_form()])
            .flatten()
            .collect(),
    );
    let authorizes = |scope: &Scope| {
        approver_authority.covers(scope)
            || scope
                .as_alternate_canonical_form()
                .is_some_and(|twin| approver_authority.covers(&twin))
    };
    let missing_scopes: Vec<String> = granted_scopes
        .iter()
        .filter(|rendered| {
            let scope = Scope::from(rendered.as_str());
            matches!(scope, Scope::FhirResource(_) | Scope::WildflowerResource(_))
                && !authorizes(&scope)
        })
        .cloned()
        .collect();
    if missing_scopes.is_empty() {
        Ok(())
    } else {
        Err(GatekeeperError::InsufficientApproverScope { missing_scopes })
    }
}
