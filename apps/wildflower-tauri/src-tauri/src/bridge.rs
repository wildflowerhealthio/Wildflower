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
/// Fatal host-side failure (e.g. the API server stopped) surfaced to the
/// webview so the user sees something other than a wedged app. Not part
/// of a typed slice bridge — it carries a bare human-readable string the
/// shell renders; emitting an event avoids pulling in a dialog plugin.
pub const FATAL_ERROR_EVENT: &str = "bridge:FatalError";

/// Emit a fatal-error message to the webview. Best-effort: if the emit
/// itself fails there is nowhere left to surface it but the host log.
pub fn emit_fatal_error(app: &AppHandle, message: &str) {
    if let Err(error) = app.emit(FATAL_ERROR_EVENT, message) {
        log::error!("[bridge] failed to emit FatalError: {error}");
    }
}

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

/// One console argument as text: bare strings as-is, everything else
/// as compact JSON.
fn render_value(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// Render a console-args array the way devtools would.
///
/// When the first argument is a string containing `%`-specifiers
/// (React and friends log `console.error("%o\n\n%s", error, stack)`),
/// substitute the remaining arguments in order: `%s`/`%d`/`%i`/`%f`
/// render like a bare value, `%o`/`%O`/`%j` render as compact JSON
/// (strings quoted, as devtools' object formatter would), `%c`
/// consumes its CSS argument and renders nothing, and `%%` is a
/// literal `%`. A specifier with no argument left stays literal.
/// Arguments beyond the specifiers — and all arguments when the first
/// isn't a format string — are appended space-separated.
fn format_log_payload(payload: &[serde_json::Value]) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut args = payload.iter();
    if let Some(serde_json::Value::String(template)) = payload.first() {
        if template.contains('%') {
            args.next(); // the template itself
            let mut out = String::new();
            let mut chars = template.chars();
            while let Some(c) = chars.next() {
                if c != '%' {
                    out.push(c);
                    continue;
                }
                match chars.next() {
                    Some('%') => out.push('%'),
                    Some(spec @ ('s' | 'd' | 'i' | 'f')) => match args.next() {
                        Some(value) => out.push_str(&render_value(value)),
                        None => {
                            out.push('%');
                            out.push(spec);
                        }
                    },
                    Some(spec @ ('o' | 'O' | 'j')) => match args.next() {
                        Some(value) => out.push_str(&value.to_string()),
                        None => {
                            out.push('%');
                            out.push(spec);
                        }
                    },
                    Some('c') => {
                        // CSS styling — meaningless in a text log.
                        args.next();
                    }
                    Some(other) => {
                        out.push('%');
                        out.push(other);
                    }
                    None => out.push('%'),
                }
            }
            parts.push(out);
        }
    }
    parts.extend(args.map(render_value));
    parts.join(" ")
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
        assert_eq!(FATAL_ERROR_EVENT, "bridge:FatalError");
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

    /// React's error-boundary log shape: a `%o`/`%s` template followed
    /// by the error object and stack strings.
    #[test]
    fn log_payload_interpolates_console_format_specifiers() {
        let payload = vec![
            serde_json::Value::String("%o\n\n%s — retry %d".to_string()),
            serde_json::json!({"_id": "ParseError"}),
            serde_json::Value::String("in <MatchInnerImpl>".to_string()),
            serde_json::json!(2),
        ];
        assert_eq!(
            format_log_payload(&payload),
            "{\"_id\":\"ParseError\"}\n\nin <MatchInnerImpl> — retry 2"
        );
    }

    #[test]
    fn log_payload_appends_args_beyond_the_specifiers() {
        let payload = vec![
            serde_json::Value::String("count: %i".to_string()),
            serde_json::json!(7),
            serde_json::Value::String("extra".to_string()),
            serde_json::json!({"k": true}),
        ];
        assert_eq!(format_log_payload(&payload), r#"count: 7 extra {"k":true}"#);
    }

    #[test]
    fn log_payload_consumes_css_args_and_keeps_literal_percents() {
        let payload = vec![
            serde_json::Value::String("%cstyled%% %s %q".to_string()),
            serde_json::Value::String("color: red".to_string()),
            serde_json::Value::String("done".to_string()),
        ];
        assert_eq!(format_log_payload(&payload), "styled% done %q");
    }

    /// A specifier with no argument left stays literal instead of
    /// vanishing — `console.log("100%s")` with no args prints `100%s`.
    #[test]
    fn log_payload_keeps_dangling_specifiers_literal() {
        let payload = vec![serde_json::Value::String("100%s and 100%".to_string())];
        assert_eq!(format_log_payload(&payload), "100%s and 100%");
    }
}
