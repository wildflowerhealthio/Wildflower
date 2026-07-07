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
//! ## Owner-session seeding for tunnel targets (#256)
//!
//! A cloud / `requires_tunnel` launch opens the app's **tunnel-origin** URL,
//! which immediately redirects into the tunnel-origin gatekeeper OAuth consent
//! flow. That flow must recognise the owner — but the popup's cookie jar is
//! empty, and the loopback-provenance trust (`inject_loopback_owner_token`)
//! deliberately never extends to relayed (`Forwarded`) callers. So before the
//! popup opens, the host seeds the same `wf_auth`/`wf_auth_exp` cookies a web
//! user would hold, built by [`gatekeeper_rust::owner_session_cookies`] and
//! scoped to the tunnel public host + its subdomains. See
//! [`cookies_for_target`] for the exact gating.

use std::sync::Arc;

use apps_rust::OnDeviceWebviewHandle;
use tauri::AppHandle;
use tauri_plugin_log::log;
use tauri_plugin_native_webview::{CookieSameSite, CookieSpec};
use tokio::sync::watch;
use tunnel_rust::TunnelService;

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
    fn open(&self, title: String, url: String) {
        let handle = self.app.clone();
        let token = self.token_rx.borrow().clone();
        let tunnel = Arc::clone(&self.tunnel);

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
            if let Err(error) = open_app_in_native_webview(&handle, title, url, cookies) {
                log::error!("[launch] failed to open native webview for launch: {error}");
            }
        });
    }
}

/// Compute the cookies to seed into the popup for `url` — the owner session
/// pair, or nothing. Pure, so the gating is unit-testable.
///
/// Seeds only when **all** hold:
/// - a host owner token exists;
/// - a tunnel `public_host` is configured;
/// - the target scheme is **https** — for the loopback provenance that reaches
///   `open()`, http targets (loopback / self-hosted / system, all
///   `http://127.0.0.1…`) already authenticate by connection provenance and
///   need no cookie.
///
/// The target's host is deliberately NOT required to be under the tunnel host:
/// a cloud app's launch URL points at the app's **own** domain (e.g.
/// `https://hbr.alumicoin.cloud/launch?iss=https://<tunnel host>/fhir-r4…`),
/// and the tunnel origin only appears when the app redirects back into the
/// gatekeeper authorize flow. What confines the bearer is the cookie's
/// `Domain=<tunnel host>` (subdomain-inclusive) — the store holds it, but it is
/// only ever *sent* to the tunnel host and its subdomains, never to the
/// third-party origin. See the multi-tenant guard on
/// [`gatekeeper_rust::owner_session_cookies`]. For an https app that never
/// touches the tunnel, the seeded cookie just sits unused.
fn cookies_for_target(
    token: Option<&str>,
    url: &str,
    tunnel_host: Option<&str>,
) -> Vec<CookieSpec> {
    let (Some(token), Some(tunnel_host)) = (token, tunnel_host) else {
        return vec![];
    };
    let is_https = tauri::Url::parse(url).is_ok_and(|parsed| parsed.scheme() == "https");
    if !is_https {
        return vec![];
    }
    gatekeeper_rust::owner_session_cookies(token, tunnel_host, /* secure */ true)
        .iter()
        .map(|cookie| cookie_spec_from(cookie, tunnel_host))
        .collect()
}

/// Map one gatekeeper-built cookie onto the plugin's wire [`CookieSpec`].
/// The fallbacks mirror the builder's invariants (it always sets every
/// attribute); they exist so a builder change degrades safely instead of
/// panicking in the launch path.
fn cookie_spec_from(cookie: &tauri::webview::cookie::Cookie<'_>, tunnel_host: &str) -> CookieSpec {
    use tauri::webview::cookie::SameSite;
    CookieSpec {
        name: cookie.name().to_owned(),
        value: cookie.value().to_owned(),
        domain: cookie.domain().unwrap_or(tunnel_host).to_owned(),
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

/// Present `url` in the shared native webview popup, titled with `title` (the
/// launched app's name), seeding `cookies` into its store before the first
/// navigation.
///
/// Validates the URL is `http(s)://` (defense-in-depth — the server already
/// builds it from a trusted loopback/tunnel origin), then `open_url`s it and
/// `show`s the popup. The plugin's hide/dispose model keeps visibility
/// independent of content, so building/navigating (`open_url`) and presenting
/// (`show`) are two calls — mirroring the sniffer's present path. The apps
/// launch flow has no host↔popup bridge of its own (no sniffing, no host→web
/// reply), so it injects no `init_script` and passes a no-op event channel — the
/// popup is self-contained and the user closes it from the native chrome. Both calls
/// are idempotent: a second launch while a popup is up navigates the existing
/// content webview and re-shows it rather than stacking a new presentation.
fn open_app_in_native_webview(
    handle: &AppHandle,
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

    // No popup events to consume: native chrome owns the Close button and the
    // apps flow expects no host→web reply, so a no-op channel satisfies the
    // plugin's `open_url` contract without re-emitting anything onto a bridge.
    // Unlike the sniffer, the apps launch holds no long-lived channel — it never
    // reacts to `Hidden`/`Disposed`; the plugin's own teardown backstop reclaims
    // an idle-hidden popup.
    let channel: Channel<NativeWebviewEvent> = Channel::new(|_event| Ok(()));
    // The domain the cookies are scoped to, kept for the read-back below — the
    // launch URL itself is typically on the third-party app's domain, where a
    // tunnel-scoped cookie would (correctly) not match.
    let seeded_domain = cookies.first().map(|cookie| cookie.domain.clone());
    handle
        .native_webview()
        .open_url(OpenRequest {
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
        })
        .map_err(|error| anyhow::anyhow!("tauri-plugin-native-webview open_url failed: {error}"))?;
    // Desktop `open_url` returns only after build + cookie seed + navigate, so
    // a read-back here observes the committed store. Queried against the
    // seeded *domain* (the tunnel host), not the launch URL — the cookie is
    // deliberately invisible to the third-party launch origin. Names only
    // (never values); an empty read-back is the smoking gun for a platform
    // cookie-write failure.
    #[cfg(desktop)]
    if let Some(domain) = seeded_domain {
        if let Ok(parsed) = tauri::Url::parse(&format!("https://{domain}/")) {
            match handle.native_webview().content_cookie_names_for_url(parsed) {
                Ok(Some(names)) => log::info!(
                    "[launch] popup cookie store for https://{domain}/ now holds: {names:?}"
                ),
                Ok(None) => log::warn!("[launch] cookie read-back: no content webview open"),
                Err(error) => log::warn!("[launch] cookie read-back failed: {error}"),
            }
        }
    }
    #[cfg(not(desktop))]
    let _ = seeded_domain;
    handle
        .native_webview()
        .show()
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

    /// A cloud app's launch URL points at the app's OWN third-party domain
    /// (the tunnel origin only appears when it redirects back for authorize) —
    /// it still seeds, and the `Domain` stays the tunnel host, so the bearer is
    /// only ever sent to the tunnel origin, never the third-party one.
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

    /// http targets never seed: loopback / self-hosted / system launches are
    /// `http://127.0.0.1…` and authenticate by connection provenance.
    #[test]
    fn never_seeds_an_http_target() {
        let cookies = cookies_for_target(
            Some(TOKEN),
            "http://127.0.0.1:4180/apps/patient-browser",
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
