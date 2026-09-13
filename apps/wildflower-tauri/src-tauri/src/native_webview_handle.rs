//! The Tauri host's [`apps_rust::OnDeviceWebviewHandle`].
//!
//! The apps launch handler (`POST /apps/{id}`) resolves the launch URL and, for
//! a loopback (local) caller, hands it here instead of returning a `302`. This
//! handle opens the resolved URL in a separate, less-privileged native webview
//! popup via [`tauri_plugin_native_webview`] — so the main SPA stays mounted
//! and the user dismisses the popup from the plugin's native chrome (Close /
//! Back / Forward). This replaces the former `RequestSandboxedWebView` bridge
//! round-trip: the server already owns origin/tunnel resolution, so the host
//! only needs the finished URL.
//!
//! ## Owner-session seeding (#256)
//!
//! Some launches open a URL whose page then navigates into a gatekeeper OAuth
//! flow that must recognise the owner — but the popup's cookie jar starts empty
//! and the loopback-provenance owner trust (`inject_loopback_owner_token`)
//! doesn't reach every such navigation. So before the popup opens, the host
//! seeds the same `wf_auth`/`wf_auth_exp` cookies a web user would hold, built
//! by [`gatekeeper_rust::owner_session_cookies`]. Two targets need it:
//!
//! - **Cloud / `requires_tunnel`** opens the app's **tunnel-origin** URL, which
//!   redirects into the tunnel-origin consent flow. The popup jar is empty and
//!   the loopback trust deliberately never extends to relayed (`Forwarded`)
//!   callers. Seeded `Secure`, scoped to the tunnel public host + its subdomains.
//! - **Self-hosted / system SMART on loopback** opens `http://127.0.0.1:<port>`,
//!   and a SMART app's `fhirclient` then navigates the popup to the loopback
//!   gatekeeper `/authorize` surface. That surface is a *pre-auth public path*,
//!   which `inject_loopback_owner_token` skips (a stray owner bearer there could
//!   confuse client auth) — so the owner session has to ride a cookie instead.
//!   Seeded **non-`Secure`** (WebKit won't send a `Secure` cookie over http
//!   loopback) and scoped to the loopback host itself, shared by the app port
//!   and the API `:8080`.
//!
//! See [`cookies_for_target`] for the exact gating.

use std::sync::Arc;

use apps_rust::OnDeviceWebviewHandle;
use tauri::AppHandle;
use tauri_plugin_log::log;
use tauri_plugin_native_webview::{CookieSameSite, CookieSpec};
use tokio::sync::watch;

use tunnel_rust::TunnelService;

/// The `tauri-plugin-native-webview` instance id for an apps-launch popup. Each
/// launched app gets its **own** instance keyed `launch-<app-id>` — distinct from
/// the browser sniffer's scrape webview (`"sniffer"`) and from every other app,
/// so launching an app never navigates another app's (or a running scrape's)
/// webview, and each app keeps its own history/session and its own entry in the
/// mobile presentation stack. App ids are kebab slugs (`[a-z0-9-]`), so the
/// composed id stays a valid Tauri window label on desktop
/// (`native-webview-launch-<app-id>`).
fn launch_webview_id(app_id: &str) -> String {
    format!("launch-{app_id}")
}

/// The host's on-device webview handle: opens the resolved launch URL in a
/// native webview popup, seeding the owner session cookies when the target is
/// the tunnel origin (see the module doc).
pub struct NativeWebviewHandle {
    app: AppHandle,
    /// Latest host-minted owner bearer (`None` until minted) — subscribed from
    /// the same `host_owner_token_sender` watch channel the bridge and
    /// `LoopbackOwnerTrust` read, so the popup cookie and the loopback trust
    /// can't hold different tokens.
    token_rx: watch::Receiver<Option<String>>,
    /// Authoritative source of the tunnel `public_host`, read at open time (it
    /// can change at runtime) — never derived by parsing the launch URL, which
    /// could be an app *subdomain* and would yield a too-narrow cookie
    /// `Domain` missing sibling subdomains.
    tunnel: Arc<dyn TunnelService>,
}

impl NativeWebviewHandle {
    pub fn new(
        app: AppHandle,
        token_rx: watch::Receiver<Option<String>>,
        tunnel: Arc<dyn TunnelService>,
    ) -> Self {
        Self {
            app,
            token_rx,
            tunnel,
        }
    }
}

impl OnDeviceWebviewHandle for NativeWebviewHandle {
    /// Open `url` in the shared native webview popup, titled with the app's
    /// name. Fire-and-forget: the underlying `tauri-plugin-native-webview`
    /// `open_url` does `run_on_main_thread(...)` then blocks on `rx.recv()` until
    /// the main thread finishes building the popup — so the actual open is
    /// dispatched onto a blocking thread via `tauri::async_runtime::spawn_blocking`
    /// rather than held on the request worker. The launch handler has already
    /// `204`d by the time the popup is constructed, and a failure here is
    /// logged (the handler can't surface it anyway).
    ///
    /// The handler only calls this for a loopback (local) caller — a host popup
    /// is useless to a remote one — so this impl doesn't re-check provenance.
    fn open(&self, app_id: String, title: String, url: String) {
        let handle = self.app.clone();
        let token = self.token_rx.borrow().clone();
        let tunnel = Arc::clone(&self.tunnel);
        // Each app gets its own `launch-<app-id>` instance (see `launch_webview_id`).
        let id = launch_webview_id(&app_id);

        tauri::async_runtime::spawn_blocking(move || {
            // Read the tunnel host on the blocking thread — it's a settings
            // read that may touch storage. The cookie is a snapshot of the
            // owner token at open time; a mid-session re-mint leaves the popup
            // cookie stale (→ 401), acceptable for the short consent flow.
            let tunnel_host = tunnel.current_public_host();
            let cookies = cookies_for_target(token.as_deref(), &url, tunnel_host.as_deref());
            // Make the seeding decision observable (never the token itself):
            // "no cookie in the popup" debugging starts here.
            if cookies.is_empty() {
                log::info!(
                    "[launch] no owner-session cookies seeded for {url} \
                     (token present: {}, tunnel host: {tunnel_host:?})",
                    token.is_some(),
                );
            } else {
                log::info!(
                    "[launch] seeding {} owner-session cookies scoped to {tunnel_host:?}",
                    cookies.len(),
                );
            }
            if let Err(error) = open_app_in_native_webview(&handle, &id, title, url, cookies) {
                log::error!("[launch] failed to open native webview for launch: {error}");
            }
        });
    }
}

/// Compute the cookies to seed into the popup for `url` — the owner session
/// pair, or nothing. Pure, so the gating is unit-testable. Always requires a
/// host owner token; the target's scheme then picks the cookie host + `Secure`:
///
/// - **https** — a cloud / tunnel launch. Scoped to the authoritative tunnel
///   `public_host` (never the target's own third-party host — the multi-tenant
///   guard on [`gatekeeper_rust::owner_session_cookies`]), `Secure`. The launch
///   URL may be on its own domain; the tunnel origin only appears when it
///   redirects into the authorize flow, and `Domain=<tunnel host>` confines the
///   bearer regardless. Nothing is seeded when no tunnel host is configured.
/// - **http on a loopback host** (`127.0.0.1` / `::1` / `localhost`) — a
///   self-hosted / system launch. A SMART app's popup detours through the
///   loopback gatekeeper OAuth surface, a pre-auth public path the
///   connection-provenance owner-token injection skips, so the owner session
///   rides a cookie instead. Scoped to the loopback host itself (shared by the
///   app port and the API `:8080`) and **not** `Secure` (WebKit won't send a
///   `Secure` cookie over http loopback). Needs no tunnel host.
/// - any other target (a non-loopback http host) seeds nothing — the owner
///   bearer never leaves loopback or the tunnel host.
fn cookies_for_target(
    token: Option<&str>,
    url: &str,
    tunnel_host: Option<&str>,
) -> Vec<CookieSpec> {
    let Some(token) = token else {
        return vec![];
    };
    let Ok(parsed) = tauri::Url::parse(url) else {
        return vec![];
    };
    let (cookie_host, secure) = match parsed.scheme() {
        "https" => (tunnel_host, true),
        "http" if host_is_loopback(&parsed) => (parsed.host_str(), false),
        _ => (None, false),
    };
    let Some(cookie_host) = cookie_host else {
        return vec![];
    };
    gatekeeper_rust::owner_session_cookies(token, cookie_host, secure)
        .iter()
        .map(|cookie| cookie_spec_from(cookie, cookie_host))
        .collect()
}

/// Whether `url`'s host is a loopback address (`127.0.0.0/8`, `::1`) or
/// `localhost` — the only http hosts the owner session is ever planted on, so a
/// stray non-loopback http target can never receive the bearer.
fn host_is_loopback(url: &tauri::Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    // `host_str` brackets an IPv6 literal (`[::1]`); strip them so it parses as
    // an `IpAddr`. A hostname never parses as an IP, so this stays false for one.
    let unbracketed = host
        .strip_prefix('[')
        .and_then(|inner| inner.strip_suffix(']'))
        .unwrap_or(host);
    unbracketed
        .parse::<std::net::IpAddr>()
        .is_ok_and(|ip| ip.is_loopback())
}

/// Map one gatekeeper-built cookie onto the plugin's wire [`CookieSpec`].
/// The fallbacks mirror the builder's invariants (it always sets every
/// attribute); they exist so a builder change degrades safely instead of
/// panicking in the launch path.
fn cookie_spec_from(cookie: &tauri::webview::cookie::Cookie<'_>, cookie_host: &str) -> CookieSpec {
    use tauri::webview::cookie::SameSite;
    CookieSpec {
        name: cookie.name().to_owned(),
        value: cookie.value().to_owned(),
        domain: cookie.domain().unwrap_or(cookie_host).to_owned(),
        path: cookie.path().unwrap_or("/").to_owned(),
        secure: cookie.secure().unwrap_or(true),
        http_only: cookie.http_only().unwrap_or(false),
        same_site: match cookie.same_site() {
            Some(SameSite::Strict) => CookieSameSite::Strict,
            Some(SameSite::None) => CookieSameSite::None,
            Some(SameSite::Lax) | None => CookieSameSite::Lax,
        },
        max_age: cookie.max_age().map(|age| age.whole_seconds()),
    }
}

/// Present `url` in the `id` native webview popup, titled with `title` (the
/// launched app's name), seeding `cookies` into its store before the first
/// navigation.
///
/// Validates the URL is `http(s)://` (defense-in-depth — the server already
/// builds it from a trusted origin), then `open_url`s it and `show`s it (two
/// calls, per the plugin's visibility-independent-of-content model). The apps
/// launch has no host↔popup bridge, so it injects no `init_script` and passes a
/// no-op event channel. Both calls are idempotent per `id`: re-launching the
/// **same** app navigates its existing popup, while a different app opens its own
/// instance (presented on top of the stack on mobile).
fn open_app_in_native_webview(
    handle: &AppHandle,
    id: &str,
    title: String,
    url: String,
    cookies: Vec<CookieSpec>,
) -> anyhow::Result<()> {
    use tauri::ipc::Channel;
    use tauri_plugin_native_webview::{NativeWebviewEvent, NativeWebviewExt, OpenRequest};

    // `resolve_http_url` enforces http(s)-only (rejecting `file:` / `javascript:`
    // and unparseable URLs). We only need it to gate the string; the plugin
    // re-parses it.
    shared_structures_tauri_rust::resolve_http_url(&url)
        .map_err(|error| anyhow::anyhow!("launch URL rejected: {error}"))?;

    // No popup events to consume: native chrome owns Close and the apps flow
    // expects no host→web reply, so a no-op channel satisfies `open_url`.
    let channel: Channel<NativeWebviewEvent> = Channel::new(|_event| Ok(()));
    handle
        .native_webview()
        .open_url(
            id,
            OpenRequest {
                url: url.to_owned(),
                // No host↔popup bridge on the apps-launch path, so no document-start
                // script is injected.
                init_script: None,
                native_webview_event_channel: channel,
                // Native chrome defaults its title to the URL host (e.g. a bare
                // `127.0.0.1`); show the launched app's own name instead.
                initial_title: Some(title),
                initial_subtitle: None,
                initial_message: None,
                cookies,
                // No download story for launched apps yet; the plugin's
                // default blocks them.
                download_dir: None,
            },
        )
        .map_err(|error| anyhow::anyhow!("tauri-plugin-native-webview open_url failed: {error}"))?;
    // No cookie read-back here: `open_url` is asynchronous with respect to the
    // seed (the desktop backend writes the store from a completion block, off the
    // path that used to deadlock the app), so a read from this thread would race
    // the writes and report an empty jar on a launch that went on to work fine.
    // What replaces it is macOS-only, as the deadlock was: there the plugin logs
    // the read-back from its own seed completion — grep the launch log for
    // `[native-webview] cookie store for … now holds`. Linux/Windows keep the
    // wry seed path, which has no post-seed read-back, so their only cookie
    // evidence is a `[native-webview] cookie seed failed` on a hard error.
    handle
        .native_webview()
        .show(id)
        .map_err(|error| anyhow::anyhow!("tauri-plugin-native-webview show failed: {error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const TUNNEL_HOST: &str = "ruth.wildflowerhealth.io";
    const TOKEN: &str = "eyJh.eyJi.sig";

    /// An https target on the tunnel apex with a token present seeds both
    /// owner session cookies, `Domain`-scoped to the full tunnel host (never
    /// its registrable parent — the multi-tenant guard).
    #[test]
    fn seeds_owner_cookies_for_https_target_on_the_tunnel_host() {
        let cookies = cookies_for_target(
            Some(TOKEN),
            "https://ruth.wildflowerhealth.io/oauth/authorize?x=1",
            Some(TUNNEL_HOST),
        );
        assert_eq!(cookies.len(), 2);
        assert_eq!(cookies[0].name, "wf_auth");
        assert_eq!(cookies[0].value, TOKEN);
        assert!(cookies[0].http_only);
        assert_eq!(cookies[1].name, "wf_auth_exp");
        assert!(!cookies[1].http_only);
        for cookie in &cookies {
            assert_eq!(cookie.domain, TUNNEL_HOST);
            assert_eq!(cookie.path, "/");
            assert!(cookie.secure);
            assert_eq!(cookie.same_site, CookieSameSite::Lax);
        }
    }

    /// A cloud app's launch URL is on its own third-party domain, yet it still
    /// seeds — the `Domain` stays the tunnel host, so the bearer never reaches it.
    #[test]
    fn seeds_for_a_third_party_https_target_with_tunnel_domain() {
        for url in [
            "https://hbr.alumicoin.cloud/launch?iss=https%3A%2F%2Fruth.wildflowerhealth.io%2Ffhir-r4",
            "https://patient-browser.ruth.wildflowerhealth.io/",
        ] {
            let cookies = cookies_for_target(Some(TOKEN), url, Some(TUNNEL_HOST));
            assert_eq!(cookies.len(), 2, "must seed {url}");
            assert_eq!(cookies[0].domain, TUNNEL_HOST);
            assert_eq!(cookies[1].domain, TUNNEL_HOST);
        }
    }

    /// An http *loopback* target (a self-hosted / system SMART launch on
    /// `http://127.0.0.1:<port>`) seeds the owner session so the popup's SMART
    /// OAuth navigation to the loopback API is recognised — scoped to the
    /// loopback host itself and **not** `Secure` (WebKit won't send a `Secure`
    /// cookie over http loopback). Needs no tunnel host.
    #[test]
    fn seeds_owner_cookies_for_a_loopback_http_target() {
        let cookies = cookies_for_target(
            Some(TOKEN),
            "http://127.0.0.1:8090/launch.html?iss=http://127.0.0.1:8080/fhir-r4",
            None,
        );
        assert_eq!(cookies.len(), 2);
        assert_eq!(cookies[0].name, "wf_auth");
        assert_eq!(cookies[0].value, TOKEN);
        assert!(cookies[0].http_only);
        assert_eq!(cookies[1].name, "wf_auth_exp");
        assert!(!cookies[1].http_only);
        for cookie in &cookies {
            assert_eq!(cookie.domain, "127.0.0.1");
            assert_eq!(cookie.path, "/");
            assert!(!cookie.secure);
            assert_eq!(cookie.same_site, CookieSameSite::Lax);
        }
    }

    /// `localhost` counts as loopback too — some hosts serve on it — and seeds
    /// scoped to the `localhost` name.
    #[test]
    fn seeds_owner_cookies_for_a_localhost_http_target() {
        let cookies = cookies_for_target(Some(TOKEN), "http://localhost:8090/launch.html", None);
        assert_eq!(cookies.len(), 2);
        for cookie in &cookies {
            assert_eq!(cookie.domain, "localhost");
            assert!(!cookie.secure);
        }
    }

    /// A *non-loopback* http target never seeds — the owner bearer must never
    /// leave loopback or the tunnel host, even with a token and tunnel host set.
    #[test]
    fn never_seeds_a_non_loopback_http_target() {
        let cookies = cookies_for_target(
            Some(TOKEN),
            "http://evil.example.test/apps/patient-browser",
            Some(TUNNEL_HOST),
        );
        assert!(cookies.is_empty());
    }

    /// No owner token (not yet minted) → nothing to seed.
    #[test]
    fn never_seeds_without_a_token() {
        let cookies =
            cookies_for_target(None, "https://ruth.wildflowerhealth.io/", Some(TUNNEL_HOST));
        assert!(cookies.is_empty());
    }

    /// No configured tunnel host → nothing to seed even for an https target
    /// (there is no authoritative `Domain` to scope the bearer to).
    #[test]
    fn never_seeds_without_a_tunnel_host() {
        let cookies = cookies_for_target(Some(TOKEN), "https://ruth.wildflowerhealth.io/", None);
        assert!(cookies.is_empty());
    }

    /// Whatever the target, the cookie `Domain` is always the configured
    /// tunnel host — never the registrable parent (which would leak the bearer
    /// to sibling tenants) and never the target's own host.
    #[test]
    fn domain_is_always_the_full_tunnel_host() {
        let cookies = cookies_for_target(Some(TOKEN), "https://example.test/", Some(TUNNEL_HOST));
        for cookie in &cookies {
            assert_eq!(cookie.domain, TUNNEL_HOST);
            assert_ne!(cookie.domain, "wildflowerhealth.io");
        }
    }
}
