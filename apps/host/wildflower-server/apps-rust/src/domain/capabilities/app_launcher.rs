//! The launch capability — [`AppLauncher`], gated by the `wildflower/launch`
//! umbrella ([`app_launcher_scopes`](super::app_launcher_scopes)).

use wildflowerhealthio_scopes::Scope;

/// Launch a scoped app — the `wildflower/launch` umbrella. A **known** scope, so
/// (unlike `wildflower/Apps.*`) it is NOT covered by the `wildflower/*` resource
/// wildcard and must be granted explicitly.
pub(crate) fn app_launcher_scopes() -> Vec<Scope> {
    vec![Scope::any_scoped_app_launch()]
}

/// Launch authorization — the capability behind `POST /apps/{id}`, gated by
/// `wildflower/launch` alone. What a SMART app may then do is the
/// authorization server's to bound, at the app's own `/oauth/authorize`: its
/// code carries only what the launching browser's session also holds.
///
/// Holds nothing: the launch handler resolves the app through the
/// (state-held) store as exempted launch glue, so holding an `AppLauncher` is
/// only the proof the umbrella check ran.
pub(crate) struct AppLauncher;
