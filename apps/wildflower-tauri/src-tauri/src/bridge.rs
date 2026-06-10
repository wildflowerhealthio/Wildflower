use std::sync::Arc;

use gatekeeper_rust::bridge::GatekeeperHostToWeb;
use serde::Deserialize;
use tauri::{AppHandle, Emitter, Listener};
use tauri_plugin_log::log;
use tokio::sync::{watch, Notify};

/// Event-name convention `bridge:{tag}` — must match the TS side in
/// `global/effect-messaging/effect-messaging-tauri/src/event-names.ts`.
pub const READY_EVENT: &str = "bridge:__Ready";
pub const AUTH_TOKEN_ISSUED_EVENT: &str = "bridge:AuthTokenIssued";
pub const LOG_EVENT: &str = "bridge:Log";

/// Wire shape of a `bridge:Log` payload, pinned by
/// `effect-messaging-core/src/logging.ts` (`LogMessageBody`). The
/// `_tag` field rides along on the wire; serde ignores it as an
/// unknown field.
#[derive(Debug, PartialEq, Deserialize)]
struct LogMessage {
    level: LogLevel,
    payload: Vec<serde_json::Value>,
}

#[derive(Debug, PartialEq, Deserialize)]
#[serde(rename_all = "lowercase")]
enum LogLevel {
    Debug,
    Info,
    Log,
    Warn,
    Error,
}

impl LogLevel {
    /// `log` is the browser console's INFO-level alias — the `log` crate
    /// has no distinct "log" rung, so it lands at INFO alongside `info`.
    fn as_log_level(&self) -> log::Level {
        match self {
            LogLevel::Debug => log::Level::Debug,
            LogLevel::Info | LogLevel::Log => log::Level::Info,
            LogLevel::Warn => log::Level::Warn,
            LogLevel::Error => log::Level::Error,
        }
    }
}

/// Render a console-args array the way devtools would: bare strings
/// as-is, everything else as compact JSON, space-separated.
fn format_log_payload(payload: &[serde_json::Value]) -> String {
    payload
        .iter()
        .map(|value| match value {
            serde_json::Value::String(s) => s.clone(),
            other => other.to_string(),
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Senders for server-originated host→web state. The bridge constructs
/// the underlying channels (it owns the receiving ends for the lifetime
/// of its resident task) and hands this struct to the caller; the
/// server task publishes through it. Grows one field per state — slice
/// crates never see this type, they take a bare `&watch::Sender`.
pub struct BridgePublishers {
    pub host_owner_token_sender: watch::Sender<Option<String>>,
}

/// Wire the webview↔host bridge onto Tauri's event bus and return the
/// publishers the server task feeds.
///
/// - Token delivery: one resident task emits the current host owner
///   token as `bridge:AuthTokenIssued` whenever the webview signals
///   `bridge:__Ready` (every page load and reload — the web side's
///   token store is in-memory and resets on reload) **and** whenever
///   the token itself changes on the watch channel (mid-session
///   re-mint) — the same dual delivery paths as the Expo host binding.
///   `Notify`'s single stored permit collapses a `__Ready` burst into
///   one delivery, and a permit stored before the task first polls is
///   not lost, so the boot race is covered.
/// - `bridge:Log`: forwards the webview's intercepted `console.*`
///   output into the host's `log` facade. Logging is one-way — the log
///   plugin has no Webview target, so nothing here can echo back into
///   the webview and loop.
pub fn attach_bridge(app: &AppHandle) -> BridgePublishers {
    let (host_owner_token_sender, mut token_rx) = watch::channel::<Option<String>>(None);

    let ready = Arc::new(Notify::new());
    {
        let ready = Arc::clone(&ready);
        app.listen(READY_EVENT, move |_event| ready.notify_one());
    }

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                _ = ready.notified() => {}
                changed = token_rx.changed() => {
                    if changed.is_err() {
                        log::error!("[bridge] token channel closed; token delivery stopped");
                        return;
                    }
                }
            }
            // `borrow_and_update` marks the value seen, so a delivery
            // triggered by `__Ready` doesn't re-fire the `changed` arm
            // for the same token. A token change landing before the
            // first page load emits into the void (Tauri events aren't
            // buffered) — harmless, the eventual `__Ready` re-delivers.
            let token = token_rx.borrow_and_update().clone();
            // `__Ready` before the server has minted: nothing to send
            // yet; the `changed` arm delivers the moment it exists.
            let Some(token) = token else { continue };
            let message = GatekeeperHostToWeb::AuthTokenIssued { token };
            match handle.emit(AUTH_TOKEN_ISSUED_EVENT, &message) {
                Ok(()) => log::debug!("[bridge] AuthTokenIssued delivered to webview"),
                Err(error) => log::error!("[bridge] failed to emit AuthTokenIssued: {error}"),
            }
        }
    });

    app.listen(LOG_EVENT, |event| {
        match serde_json::from_str::<LogMessage>(event.payload()) {
            Ok(message) => log::log!(
                message.level.as_log_level(),
                "[webview] {}",
                format_log_payload(&message.payload)
            ),
            Err(error) => log::warn!("[bridge] undecodable bridge:Log payload dropped: {error}"),
        }
    });

    BridgePublishers {
        host_owner_token_sender,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Drift guard: the TS side pins the same literals in
    /// `effect-messaging-tauri/src/event-names.test.ts`.
    #[test]
    fn event_names_match_the_ts_convention() {
        assert_eq!(READY_EVENT, "bridge:__Ready");
        assert_eq!(AUTH_TOKEN_ISSUED_EVENT, "bridge:AuthTokenIssued");
        assert_eq!(LOG_EVENT, "bridge:Log");
    }

    #[test]
    fn log_message_decodes_the_wire_payload_ignoring_tag() {
        let decoded: LogMessage =
            serde_json::from_str(r#"{"_tag":"Log","level":"warn","payload":["boom",{"code":7}]}"#)
                .expect("decode");
        assert_eq!(
            decoded,
            LogMessage {
                level: LogLevel::Warn,
                payload: vec![
                    serde_json::Value::String("boom".to_string()),
                    serde_json::json!({"code": 7}),
                ],
            }
        );
    }

    #[test]
    fn console_log_alias_maps_to_info() {
        assert_eq!(LogLevel::Log.as_log_level(), log::Level::Info);
        assert_eq!(LogLevel::Info.as_log_level(), log::Level::Info);
        assert_eq!(LogLevel::Debug.as_log_level(), log::Level::Debug);
        assert_eq!(LogLevel::Warn.as_log_level(), log::Level::Warn);
        assert_eq!(LogLevel::Error.as_log_level(), log::Level::Error);
    }

    #[test]
    fn log_payload_formats_strings_bare_and_values_as_json() {
        let payload = vec![
            serde_json::Value::String("request failed".to_string()),
            serde_json::json!({"status": 401}),
            serde_json::json!(3),
        ];
        assert_eq!(
            format_log_payload(&payload),
            r#"request failed {"status":401} 3"#
        );
    }
}
