use std::sync::Arc;

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Listener};
use tauri_plugin_log::log;
use tokio::sync::{watch, Notify};
use wildflowerhealthio_gatekeeper::bridge::{GatekeeperHostToWeb, PendingConsentHeadWire};
use wildflowerhealthio_gatekeeper::PendingConsentHead;
use wildflowerhealthio_shared_structures::bridge::{BRIDGE_EVENT, READY_TAG};

/// The `Log` tag literal the bridge listener dispatches on (`__Ready` is the
/// shared [`READY_TAG`]). Matches the TS-side schema in
/// `effect-messaging-core/src/logging.ts`.
const LOG_TAG: &str = "Log";

/// Wire shape of a `Log` payload, pinned by
/// `effect-messaging-core/src/logging.ts` (`LogMessageBody`). The
/// `_tag` field rides along on the wire; serde ignores it as an
/// unknown field.
#[derive(Debug, PartialEq, Deserialize)]
struct LogMessage {
    level: LogLevel,
    payload: Vec<serde_json::Value>,
}

/// Inbound bridge messages this listener acts on, decoded in one pass.
/// Unrecognized tags (host→web echoes, sibling slices' web→host traffic)
/// fall through to `Other` and are dropped. The `__Ready` literal is
/// pinned against the TS convention by `tag_literals_match_the_ts_convention`.
#[derive(Debug, Deserialize)]
#[serde(tag = "_tag")]
enum InboundBridgeMessage {
    #[serde(rename = "__Ready")]
    Ready,
    Log(LogMessage),
    #[serde(other)]
    Other,
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
                    // An escaped `%%`, or a dangling `%` at end of template —
                    // both render as a single literal percent.
                    Some('%') | None => out.push('%'),
                    Some(spec @ ('s' | 'd' | 'i' | 'f')) => {
                        if let Some(value) = args.next() {
                            out.push_str(&render_value(value));
                        } else {
                            out.push('%');
                            out.push(spec);
                        }
                    }
                    Some(spec @ ('o' | 'O' | 'j')) => {
                        if let Some(value) = args.next() {
                            out.push_str(&value.to_string());
                        } else {
                            out.push('%');
                            out.push(spec);
                        }
                    }
                    Some('c') => {
                        // CSS styling — meaningless in a text log.
                        args.next();
                    }
                    Some(other) => {
                        out.push('%');
                        out.push(other);
                    }
                }
            }
            parts.push(out);
        }
    }
    parts.extend(args.map(render_value));
    parts.join(" ")
}

/// Senders for server-originated host→web state. The bridge constructs
/// the underlying channels (its resident task owns the receiving ends,
/// and a clone of each sender, for the life of the app) and hands this
/// struct to the caller; the server task publishes through it. Grows one
/// field per state — slice crates never see this type, they take a bare
/// `watch::Sender`.
///
/// The channels outlive any server: dropping this struct, as a setup
/// path that starts no server does, closes nothing, so the resident task
/// keeps answering `__Ready` and a server started later publishes to the
/// same webview.
pub struct BridgePublishers {
    pub host_owner_token_tx: watch::Sender<Option<String>>,
    pub active_pending_consent_tx: watch::Sender<Option<PendingConsentHead>>,
}

/// Wire the webview↔host bridge onto Tauri's event bus and return the
/// publishers the server task feeds.
///
/// - Token delivery: the bearer never reaches the JS side at all — the
///   desktop webview authenticates by *connection provenance* (the host
///   presents its own owner token for direct-loopback requests; see
///   `inject_loopback_owner_token` in `wildflower-server-rust`, which reads the same
///   token watch channel this bridge feeds). The only
///   thing that rides the multiplexed bridge channel is a contentless
///   `bridge:AuthTokenIssued` notify, emitted whenever the webview
///   signals `bridge:__Ready` (every page load and reload — the web
///   side's auth-readiness signal is in-memory and resets on reload)
///   **and** whenever the token changes on the watch channel
///   (mid-session re-mint). That notify only flips the page's
///   auth-readiness signal; it carries no secret. `Notify`'s single
///   stored permit collapses a `__Ready` burst into one delivery, and a
///   permit stored before the task first polls is not lost, so the boot
///   race is covered.
/// - Pending-consent delivery: the same task forwards the active
///   pending-consent head (or `null`) as
///   `bridge:PendingConsentRequested` on `__Ready` *and* on every
///   change. The head carries the `kind` that tells the SPA which
///   consent form to render. The webview side's
///   [`ActivePendingConsentStore`](gatekeeper-react) seeds itself off
///   the `__Ready` re-delivery, just like the token store does. Both
///   arms use `borrow_and_update` so the seen-version marker advances
///   past the just-delivered value; without that, a `__Ready` that
///   races a fresh boot-time republish would emit, then the `changed`
///   arm would immediately wake on the same unseen value and emit
///   again. A real later change still bumps the watch version and
///   wakes `changed` regardless of whether the previous value was
///   marked seen. Each server's run forwards its own head here; the
///   window is brought forward for a new consent by
///   `servers-tauri`'s `pending-consent` event, not here.
/// - `Log` tag: forwards the webview's intercepted `console.*` output
///   into the host's `log` facade. Logging is one-way — the log plugin
///   has no Webview target, so nothing here can echo back into the
///   webview and loop.
///
/// The TS-side transport multiplexes every tag onto one Tauri event
/// (`BRIDGE_EVENT` / `"bridge"`); this listener decodes the envelope's
/// `_tag` once and routes by tag. Tags we don't react to (host→web
/// emit echoes, sibling slices' web→host traffic, …) are dropped
/// silently.
pub fn attach_bridge(app: &AppHandle) -> BridgePublishers {
    let (host_owner_token_tx, mut token_rx) = watch::channel::<Option<String>>(None);
    let (active_pending_consent_tx, mut consent_rx) =
        watch::channel::<Option<PendingConsentHead>>(None);

    // The bridge channel is shared across listeners with no automated
    // cross-process tag guard; log this crate's tag set at attach time so
    // the boot log shows who dispatches what. See the effect-messaging-tauri-js
    // README ("Tag uniqueness across processes").
    log::info!("[bridge] listening on '{BRIDGE_EVENT}' for tags: [{READY_TAG}, {LOG_TAG}]");

    let ready = Arc::new(Notify::new());
    {
        let ready = Arc::clone(&ready);
        app.listen(BRIDGE_EVENT, move |event| {
            // One parse routes by `_tag` and decodes the body; tags we
            // don't own (sibling crates' traffic, host→web echoes) land on
            // `Other` and are dropped.
            match serde_json::from_str::<InboundBridgeMessage>(event.payload()) {
                Ok(InboundBridgeMessage::Ready) => ready.notify_one(),
                Ok(InboundBridgeMessage::Log(message)) => log::log!(
                    message.level.as_log_level(),
                    "[webview] {}",
                    format_log_payload(&message.payload)
                ),
                Ok(InboundBridgeMessage::Other) => {}
                Err(error) => {
                    log::warn!("[bridge] undecodable bridge payload dropped: {error}");
                }
            }
        });
    }

    let handle = app.clone();
    // The task's own senders keep both channels open for the life of the
    // app, whether or not a server ever takes the publishers (see
    // `BridgePublishers`), so its `changed` arms never see them close.
    let channels_kept_open = (
        host_owner_token_tx.clone(),
        active_pending_consent_tx.clone(),
    );
    tauri::async_runtime::spawn(async move {
        let _channels_kept_open = channels_kept_open;
        loop {
            // Which arm woke the loop drives whether we re-deliver the token
            // or the consent — see the per-outcome match below.
            enum Outcome {
                Ready,
                TokenChanged,
                ConsentChanged,
            }
            let outcome = tokio::select! {
                () = ready.notified() => Outcome::Ready,
                Ok(()) = token_rx.changed() => Outcome::TokenChanged,
                Ok(()) = consent_rx.changed() => Outcome::ConsentChanged,
            };

            match outcome {
                Outcome::Ready => {
                    // Signal auth-readiness on every page load — the web side's
                    // signal is in-memory and resets on reload.
                    notify_if_token_present(&handle, &mut token_rx);
                    // `borrow_and_update` so a `__Ready` racing a boot-time
                    // republish doesn't leave the value unseen and re-wake the
                    // `ConsentChanged` arm (see the doc comment).
                    let consent = consent_rx.borrow_and_update().clone();
                    emit_pending_consent(&handle, &consent);
                }
                Outcome::TokenChanged => notify_if_token_present(&handle, &mut token_rx),
                Outcome::ConsentChanged => {
                    let consent = consent_rx.borrow_and_update().clone();
                    emit_pending_consent(&handle, &consent);
                }
            }
        }
    });

    BridgePublishers {
        host_owner_token_tx,
        active_pending_consent_tx,
    }
}

/// Read-and-mark the current host token and emit the contentless
/// `AuthTokenIssued` notify iff it's present — the shared body of the `Ready`
/// (page-load) and `TokenChanged` (re-mint) arms.
///
/// `borrow_and_update` marks the value seen so a delivery triggered by one arm
/// doesn't re-fire the `changed` arm for the same value. The token stays
/// host-side — the desktop authenticates by loopback provenance — so only the contentless notify travels, and only for `Some` (a fresh /
/// re-minted token): a `None` (logout) just stops the host injecting it and the
/// page's loopback fetches start coming back 401, with no "logged out" notify to
/// emit. A change landing before the first page load emits into the void (Tauri
/// events aren't buffered) — harmless, the eventual `__Ready` re-delivers.
fn notify_if_token_present(handle: &AppHandle, token_rx: &mut watch::Receiver<Option<String>>) {
    if token_rx.borrow_and_update().is_some() {
        emit_auth_token_notify(handle);
    }
}

fn emit_auth_token_notify(handle: &AppHandle) {
    let message = GatekeeperHostToWeb::AuthTokenIssued;
    match handle.emit(BRIDGE_EVENT, &message) {
        Ok(()) => log::debug!("[bridge] AuthTokenIssued notify delivered to webview"),
        Err(error) => log::error!("[bridge] failed to emit AuthTokenIssued notify: {error}"),
    }
}

fn emit_pending_consent(handle: &AppHandle, head: &Option<PendingConsentHead>) {
    let message = GatekeeperHostToWeb::PendingConsentRequested {
        head: head.clone().map(PendingConsentHeadWire::from),
    };
    match handle.emit(BRIDGE_EVENT, &message) {
        Ok(()) => {
            log::debug!("[bridge] PendingConsentRequested delivered to webview (head={head:?})");
        }
        Err(error) => log::error!("[bridge] failed to emit PendingConsentRequested: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Drift guard for this crate's local tag literals. `BRIDGE_EVENT`
    /// is pinned by `wildflowerhealthio_shared_structures::bridge` (one source of
    /// truth across every Rust bridge listener); the TS side pins the
    /// same literals in `effect-messaging-tauri-js/src/event-names.test.ts`.
    #[test]
    fn tag_literals_match_the_ts_convention() {
        assert_eq!(READY_TAG, "__Ready");
        assert_eq!(LOG_TAG, "Log");
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
