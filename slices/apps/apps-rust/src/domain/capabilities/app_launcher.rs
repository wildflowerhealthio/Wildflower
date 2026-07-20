//! The launch-authorization capability — the hybrid [`AppLauncher`], gated by the
//! `wildflower/launch` umbrella ([`app_launcher_scopes`](super::app_launcher_scopes))
//! plus a per-app SMART check.

use std::sync::Arc;

use scopes_rust::{Grant, Scope};

use crate::domain::{AppRegistration, AppsError};
use crate::ports::AppLaunchScopes;

/// Launch a scoped app — the `wildflower/launch` umbrella. A **known** scope, so
/// (unlike `wildflower/Apps.*`) it is NOT covered by the `wildflower/*` resource
/// wildcard and must be granted explicitly. The per-app SMART check that a launch
/// additionally passes is data-dependent and lives on [`AppLauncher`], not here.
pub(crate) fn app_launcher_scopes() -> Vec<Scope> {
    vec![Scope::any_scoped_app_launch()]
}

/// Launch authorization — the **hybrid** capability behind `GET` / `POST
/// /apps/{id}`. Unlike the fixed-scope admin capabilities, its binding implements
/// [`Capability`](scope_capabilities_rust::Capability) directly: the static umbrella
/// `wildflower/launch` (from [`app_launcher_scopes`](super::app_launcher_scopes)) is
/// enforced by the [`Scoped`](scope_capabilities_rust::Scoped) extractor, **and** the
/// builder stores the caller's [`Grant`] for the data-dependent per-app SMART
/// check ([`missing_launch_scopes`](AppLauncher::missing_launch_scopes)).
///
/// Doesn't touch the store — the launch handler resolves the app through the
/// (state-held) store as exempted launch glue; this capability owns only the
/// authorization: the caller's grant + the [`AppLaunchScopes`] port that resolves
/// a SMART app's required scopes.
pub(crate) struct AppLauncher {
    granted: Grant,
    launch_scopes: Arc<dyn AppLaunchScopes>,
}

impl AppLauncher {
    pub(crate) fn new(granted: Grant, launch_scopes: Arc<dyn AppLaunchScopes>) -> Self {
        Self {
            granted,
            launch_scopes,
        }
    }

    /// The scopes the caller lacks to launch `registration` — empty means
    /// authorized. A **non-SMART** app (no `client_id`) needs only the umbrella
    /// scope the extractor already enforced, so it short-circuits to no missing
    /// scopes; a **SMART** app additionally requires the caller's grant to cover
    /// its OAuth client's requested scopes (resolved through the
    /// [`AppLaunchScopes`] port). The handler renders a non-empty result as a
    /// `403 InsufficientScope` (JSON for the loopback/SPA arm, a browser-appropriate
    /// response for a forwarded navigation).
    pub(crate) fn missing_launch_scopes(
        &self,
        registration: &AppRegistration,
    ) -> Result<Vec<Scope>, AppsError> {
        if !registration.is_smart() {
            return Ok(Vec::new());
        }
        let required = self.launch_scopes.required_scopes(registration)?;
        Ok(self.granted.missing_scopes(&required))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::test_fake::registration;
    use crate::domain::AppKind;

    /// A fake [`AppLaunchScopes`] returning a fixed required-scope set. The
    /// capability only consults it for a SMART app, so a non-SMART test never
    /// reaches here.
    struct FakeLaunchScopes {
        required: Vec<Scope>,
    }

    impl AppLaunchScopes for FakeLaunchScopes {
        fn required_scopes(
            &self,
            _registration: &AppRegistration,
        ) -> Result<Vec<Scope>, AppsError> {
            Ok(self.required.clone())
        }
    }

    fn launcher(granted: &str, required: &[&str]) -> AppLauncher {
        AppLauncher::new(
            Grant::parse(granted.split_whitespace()),
            Arc::new(FakeLaunchScopes {
                required: required.iter().map(|s| Scope::from(*s)).collect(),
            }),
        )
    }

    fn smart_registration() -> AppRegistration {
        let mut reg = registration("smart-app", AppKind::Cloud);
        reg.client_id = Some("client-1".to_owned());
        reg
    }

    #[test]
    fn launcher_smart_app_requires_covering_its_client_scopes() {
        let reg = smart_registration();
        // A grant covering the SMART client's scopes → nothing missing.
        assert!(launcher(
            "patient/Observation.rs openid",
            &["patient/Observation.r", "openid"]
        )
        .missing_launch_scopes(&reg)
        .expect("resolve")
        .is_empty());

        // A grant missing one → it comes back (in the order the port declared).
        let missing = launcher("openid", &["patient/Observation.r", "openid"])
            .missing_launch_scopes(&reg)
            .expect("resolve");
        assert_eq!(
            scopes_rust::render_scopes(&missing),
            vec!["patient/Observation.r".to_owned()],
        );
    }

    #[test]
    fn launcher_non_smart_app_needs_only_the_umbrella() {
        // A non-SMART app (no `client_id`) short-circuits to no missing scopes even
        // with an empty grant — the SMART port is never consulted (so the required
        // set below is irrelevant).
        let reg = registration("system-app", AppKind::System);
        assert!(reg.client_id.is_none());
        assert!(launcher("", &["patient/Observation.r"])
            .missing_launch_scopes(&reg)
            .expect("resolve")
            .is_empty());
    }
}
