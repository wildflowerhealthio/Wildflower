use std::sync::Arc;

use gatekeeper_rust::bridge::GatekeeperHostToWeb;
use serde::Deserialize;
use shared_structures_rust::bridge::BRIDGE_EVENT;
use tauri::{AppHandle, Emitter, Listener, Manager};
use tauri_plugin_log::log;
use tokio::sync::{watch, Notify};

/// Tag literals dispatched by the bridge listener. Web→host tags we
/// react to plus host→web tags we emit. Matches the TS-side schemas in
/// `gatekeeper-core/src/bridge.ts` and
/// `effect-messaging-core/src/logging.ts`.
const READY_TAG: &str = "__Ready";
const LOG_TAG: &str = "Log";

/// Tauri window label of the main webview, set in
/// `tauri.conf.json`. The consent-popup arrival path looks the window
/// up by label to raise/focus it; an unknown label is a config drift
/// and the focus call is skipped with a log.
const MAIN_WINDOW_LABEL: &str = "main";

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
/// the underlying channels (it owns the receiving ends for the lifetime
/// of its resident task) and hands this struct to the caller; the
/// server task publishes through it. Grows one field per state — slice
/// crates never see this type, they take a bare `watch::Sender`.
pub struct BridgePublishers {
    pub host_owner_token_sender: watch::Sender<Option<String>>,
    pub active_device_user_code_sender: watch::Sender<Option<String>>,
}

/// Tauri managed state backing the [`gatekeeper_current_token`] command.
///
/// Holds a `watch::Receiver` clone fed by the same channel
/// `setup_gatekeeper` publishes through, so a pull always reflects the
/// latest minted token. Lives in [`tauri::App`] managed state and is
/// reachable only from webviews whose capability grants
/// `allow-gatekeeper-current-token` — the sniffer webview's capability
/// must NOT include that permission, which is how the bearer stays
/// off any surface a hostile EHR page can reach.
pub struct GatekeeperTokenState {
    token_rx: watch::Receiver<Option<String>>,
}

/// Capability-gated pull of the current Owner bearer token. The
/// command emits no event — it only returns the watch channel's
/// current value — so a hostile page in a webview without the matching
/// `allow-gatekeeper-current-token` permission cannot reach it, and a
/// page that *can* still receives no payload through the multiplexed
/// `bridge` event channel.
///
/// `None` is the legitimate "no token yet" state during the brief
/// window between the embedded server binding its loopback port and
/// `setup_gatekeeper` minting the first token; callers should treat it
/// the same as a yet-to-arrive `AuthTokenIssued` notify (wait and retry
/// on the next notify).
#[tauri::command]
pub fn gatekeeper_current_token(state: tauri::State<'_, GatekeeperTokenState>) -> Option<String> {
    state.token_rx.borrow().clone()
}

/// Raise the main webview window to the foreground so a freshly-arrived
/// device-consent popup is visible to the operator (the whole point of
/// the popup — a `verification_uri` could pair while the user is in
/// another app). `unminimize` plus `set_focus` is the desktop pattern;
/// `is_minimized` short-circuits the unminimize call so we don't reset
/// a window that's already in view.
///
/// Scoped behind `cfg(desktop)` because mobile Tauri targets either
/// have no concept of foreground-raise (iOS forbids unsolicited focus
/// stealing) or expose the surface differently — leaving it on the
/// desktop branch keeps the iOS/Android builds linkable without a
/// stub.
#[cfg(desktop)]
fn raise_main_window(handle: &AppHandle) {
    let Some(window) = handle.get_webview_window(MAIN_WINDOW_LABEL) else {
        log::warn!("[bridge] window '{MAIN_WINDOW_LABEL}' missing; consent popup focus skipped");
        return;
    };
    if matches!(window.is_minimized(), Ok(true)) {
        if let Err(error) = window.unminimize() {
            log::warn!("[bridge] window unminimize failed: {error}");
        }
    }
    if let Err(error) = window.set_focus() {
        log::warn!("[bridge] window set_focus failed: {error}");
    }
}

/// Mobile builds don't raise the window themselves — see the desktop
/// variant. An empty stub keeps the dispatch loop platform-blind.
#[cfg(not(desktop))]
fn raise_main_window(_handle: &AppHandle) {}

/// Wire the webview↔host bridge onto Tauri's event bus and return the
/// publishers the server task feeds.
///
/// - Token delivery: one resident task emits a contentless
///   `bridge:AuthTokenIssued` notify whenever the webview signals
///   `bridge:__Ready` (every page load and reload — the web side's
///   token store is in-memory and resets on reload) **and** whenever
///   the token itself changes on the watch channel (mid-session
///   re-mint). The bearer itself never rides the multiplexed bridge
///   channel — the webview pulls it via the capability-gated
///   [`gatekeeper_current_token`] command, which sibling webviews
///   (notably the browser-sniffer loading hostile EHR pages) cannot
///   reach because their capability does not include
///   `allow-gatekeeper-current-token`.
///   `Notify`'s single stored permit collapses a `__Ready` burst into
///   one delivery, and a permit stored before the task first polls is
///   not lost, so the boot race is covered.
/// - Device-consent delivery: the same task forwards the active
///   pending device-consent head (or `null`) as
///   `bridge:DeviceConsentRequested` on `__Ready` *and* on every
///   change. The webview side's
///   [`ActiveDeviceUserCodeStore`](gatekeeper-react) seeds itself off
///   the `__Ready` re-delivery, just like the token store does. Both
///   arms use `borrow_and_update` so the seen-version marker advances
///   past the just-delivered value; without that, a `__Ready` that
///   races a fresh boot-time republish would emit, then the `changed`
///   arm would immediately wake on the same unseen value and emit
///   again (and re-fire the focus path). A real later change still
///   bumps the watch version and wakes `changed` regardless of
///   whether the previous value was marked seen.
/// - Window focus: only on a `None → Some` consent transition — that
///   is the "a new popup just appeared" signal the user needs to be
///   pulled to. `Some(A) → Some(B)` (the user actively interacting
///   with the popup as the queue head advances) does not re-focus, so
///   a window that's already foreground doesn't get a redundant
///   focus-steal pulse on every approve/deny. Clears and `__Ready`
///   re-deliveries also skip the focus call.
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
    let (host_owner_token_sender, token_rx) = watch::channel::<Option<String>>(None);
    let (active_device_user_code_sender, mut consent_rx) = watch::channel::<Option<String>>(None);

    // Expose the live token watcher to `gatekeeper_current_token` via
    // Tauri managed state. The capability gate (only the main webview's
    // capability allows the command) is what prevents sniffer-context
    // pulls — keeping the bearer off the multiplexed event bus would be
    // moot if any webview could invoke this.
    app.manage(GatekeeperTokenState {
        token_rx: token_rx.clone(),
    });
    let mut token_rx = token_rx;

    // The bridge channel is shared across listeners with no automated
    // cross-process tag guard; log this crate's tag set at attach time so
    // the boot log shows who dispatches what. See the effect-messaging-tauri
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
    tauri::async_runtime::spawn(async move {
        // Tracks the consent head we last delivered, so a `Some(A) →
        // Some(B)` transition does not re-raise an already-foreground
        // window — focus is for "a brand new popup appeared", not for
        // the user advancing through a queue they are already looking
        // at.
        let mut last_delivered_consent: Option<String> = None;
        loop {
            // Which arm woke the loop drives whether we re-deliver token,
            // re-deliver consent, and/or focus the window — see the per-
            // outcome match below.
            enum Outcome {
                Ready,
                TokenChanged,
                ConsentChanged,
            }
            let outcome = tokio::select! {
                () = ready.notified() => Outcome::Ready,
                changed = token_rx.changed() => match changed {
                    Ok(()) => Outcome::TokenChanged,
                    Err(_) => {
                        log::error!("[bridge] token channel closed; delivery stopped");
                        return;
                    }
                },
                changed = consent_rx.changed() => match changed {
                    Ok(()) => Outcome::ConsentChanged,
                    Err(_) => {
                        log::error!("[bridge] device-consent channel closed; delivery stopped");
                        return;
                    }
                },
            };

            match outcome {
                Outcome::Ready => {
                    // `borrow_and_update` marks the token seen so a
                    // delivery triggered by `__Ready` doesn't re-fire
                    // the `changed` arm for the same value.
                    let token = token_rx.borrow_and_update().clone();
                    if token.is_some() {
                        emit_auth_token_notify(&handle);
                    }
                    // Also `borrow_and_update` on consent: a `__Ready`
                    // that races a boot-time republish would otherwise
                    // leave the just-delivered value unseen and the
                    // `ConsentChanged` arm would immediately wake to
                    // re-emit the same value (and re-fire the focus
                    // path). A real later change still bumps the
                    // version and wakes `changed` regardless.
                    let consent = consent_rx.borrow_and_update().clone();
                    last_delivered_consent = consent.clone();
                    emit_device_consent(&handle, &consent);
                }
                Outcome::TokenChanged => {
                    let token = token_rx.borrow_and_update().clone();
                    // A token change landing before the first page
                    // load emits into the void (Tauri events aren't
                    // buffered) — harmless, the eventual `__Ready`
                    // re-delivers the notify and the webview pulls the
                    // current value through the gated command.
                    if token.is_none() {
                        continue;
                    }
                    emit_auth_token_notify(&handle);
                }
                Outcome::ConsentChanged => {
                    let consent = consent_rx.borrow_and_update().clone();
                    let was_none = last_delivered_consent.is_none();
                    let is_some = consent.is_some();
                    last_delivered_consent = consent.clone();
                    emit_device_consent(&handle, &consent);
                    // Raise the window only on the `None → Some`
                    // transition — that's the "a new popup just
                    // appeared" signal. `Some(A) → Some(B)` (the user
                    // advancing through a queue they're already
                    // looking at) and `Some → None` (a clear) leave
                    // focus alone.
                    if was_none && is_some {
                        raise_main_window(&handle);
                    }
                }
            }
        }
    });

    BridgePublishers {
        host_owner_token_sender,
        active_device_user_code_sender,
    }
}

fn emit_auth_token_notify(handle: &AppHandle) {
    let message = GatekeeperHostToWeb::AuthTokenIssued;
    match handle.emit(BRIDGE_EVENT, &message) {
        Ok(()) => log::debug!("[bridge] AuthTokenIssued notify delivered to webview"),
        Err(error) => log::error!("[bridge] failed to emit AuthTokenIssued notify: {error}"),
    }
}

fn emit_device_consent(handle: &AppHandle, user_code: &Option<String>) {
    let message = GatekeeperHostToWeb::DeviceConsentRequested {
        user_code: user_code.clone(),
    };
    match handle.emit(BRIDGE_EVENT, &message) {
        Ok(()) => log::debug!(
            "[bridge] DeviceConsentRequested delivered to webview (userCode={user_code:?})"
        ),
        Err(error) => log::error!("[bridge] failed to emit DeviceConsentRequested: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Drift guard for this crate's local tag literals. `BRIDGE_EVENT`
    /// is pinned by `shared_structures_rust::bridge` (one source of
    /// truth across every Rust bridge listener); the TS side pins the
    /// same literals in `effect-messaging-tauri/src/event-names.test.ts`.
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
