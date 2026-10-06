//! [`ServerRunState`], the lifecycle each run of the Wildflower server
//! reports. The background server service publishes it from each run, and the
//! servers slice reports it to the base in each server's status.

use serde::Serialize;

/// Where the current server run is.
///
/// Runs are ordered by the background server service's run gate and each run
/// writes its states in this order, so a watch of it never goes backwards:
/// `Starting` → `Running` → `Stopped`, or `Starting` → `Stopped` when startup
/// fails.
///
/// Serialised as `{"state": "starting"}`, `{"state": "running"}` or
/// `{"state": "stopped", "error": <string or null>}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum ServerRunState {
    /// A run holds the gate and is setting the server up.
    Starting,
    /// The server is bound and serving.
    Running,
    /// No run is serving. `error` is the most recent run's failure as its full
    /// `{:#}` chain, or `None` when it stopped cleanly or none has run yet.
    Stopped { error: Option<String> },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialises_tagged_by_state() {
        for (run_state, json) in [
            (
                ServerRunState::Starting,
                serde_json::json!({"state": "starting"}),
            ),
            (
                ServerRunState::Running,
                serde_json::json!({"state": "running"}),
            ),
            (
                ServerRunState::Stopped { error: None },
                serde_json::json!({"state": "stopped", "error": null}),
            ),
            (
                ServerRunState::Stopped {
                    error: Some("failed to bind".to_owned()),
                },
                serde_json::json!({"state": "stopped", "error": "failed to bind"}),
            ),
        ] {
            assert_eq!(serde_json::to_value(&run_state).unwrap(), json);
        }
    }
}
