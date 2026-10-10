//! Best-effort human-facing device name inferred from a device-code client's
//! `User-Agent`, used only when the client didn't name itself (RFC 8628's
//! `device_name` extension is absent). A browser-shaped UA becomes e.g.
//! `"Chrome on macOS"`; an unrecognized UA (the many non-browser device-code
//! clients — CLIs, TV apps, bare HTTP libraries) yields `None`, so the caller
//! falls back to the client name rather than surfacing a raw UA string as the
//! device name.
//!
//! Deliberately a tiny substring heuristic, not a full UA database: the
//! device-code surface rarely carries a rich browser UA, so a dependency-heavy
//! parser would buy little. Ordering matters — the more specific token is
//! checked first (Edge/Opera before Chrome, Chrome before Safari, the
//! Android/iOS tokens before the desktop OS they embed).

/// The browser family a UA advertises, or `None` if none is recognized.
fn browser(user_agent: &str) -> Option<&'static str> {
    // Chromium forks embed `Chrome/`, and Chrome itself embeds `Safari/`, so the
    // fork tokens (`Edg`, `OPR`, `CriOS`) must be tested before `Chrome`, and
    // `Chrome` before `Safari`.
    if user_agent.contains("Edg/") || user_agent.contains("EdgiOS/") {
        Some("Edge")
    } else if user_agent.contains("OPR/") || user_agent.contains("Opera") {
        Some("Opera")
    } else if user_agent.contains("CriOS/") || user_agent.contains("Chrome/") {
        Some("Chrome")
    } else if user_agent.contains("FxiOS/") || user_agent.contains("Firefox/") {
        Some("Firefox")
    } else if user_agent.contains("Safari/") {
        Some("Safari")
    } else {
        None
    }
}

/// The operating system / device family a UA advertises, or `None`.
fn operating_system(user_agent: &str) -> Option<&'static str> {
    // iOS and Android UAs also carry the desktop tokens they derive from
    // (`like Mac OS X`, `Linux`), so the mobile tokens are tested first.
    if user_agent.contains("iPhone") {
        Some("iPhone")
    } else if user_agent.contains("iPad") {
        Some("iPad")
    } else if user_agent.contains("Android") {
        Some("Android")
    } else if user_agent.contains("CrOS") {
        Some("ChromeOS")
    } else if user_agent.contains("Macintosh") || user_agent.contains("Mac OS X") {
        Some("macOS")
    } else if user_agent.contains("Windows") {
        Some("Windows")
    } else if user_agent.contains("Linux") {
        Some("Linux")
    } else {
        None
    }
}

/// Derive a friendly device name from a `User-Agent`, or `None` when nothing
/// recognizable is present (the caller then falls back to the client name).
///
/// `"Chrome on macOS"` when both a browser and OS are known; the single known
/// half otherwise (`"iPhone"`, `"Firefox"`); `None` when neither is.
pub(super) fn device_name_from_user_agent(user_agent: &str) -> Option<String> {
    match (browser(user_agent), operating_system(user_agent)) {
        (Some(browser), Some(os)) => Some(format!("{browser} on {os}")),
        (Some(browser), None) => Some(browser.to_owned()),
        (None, Some(os)) => Some(os.to_owned()),
        (None, None) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_browsers_render_as_browser_on_os() {
        let chrome_mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
                          (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
        assert_eq!(
            device_name_from_user_agent(chrome_mac).as_deref(),
            Some("Chrome on macOS"),
        );

        let firefox_win = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) \
                           Gecko/20100101 Firefox/126.0";
        assert_eq!(
            device_name_from_user_agent(firefox_win).as_deref(),
            Some("Firefox on Windows"),
        );
    }

    #[test]
    fn chromium_forks_win_over_the_embedded_chrome_token() {
        let edge = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                    (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0";
        assert_eq!(
            device_name_from_user_agent(edge).as_deref(),
            Some("Edge on Windows"),
        );
    }

    #[test]
    fn safari_only_when_not_chromium() {
        // Real Safari carries `Safari/` but no `Chrome/`.
        let safari_iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) \
                             AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 \
                             Mobile/15E148 Safari/604.1";
        assert_eq!(
            device_name_from_user_agent(safari_iphone).as_deref(),
            Some("Safari on iPhone"),
        );
    }

    #[test]
    fn android_wins_over_the_linux_token_it_embeds() {
        let android = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 \
                       (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36";
        assert_eq!(
            device_name_from_user_agent(android).as_deref(),
            Some("Chrome on Android"),
        );
    }

    #[test]
    fn non_browser_clients_yield_none() {
        // The typical device-code caller: a CLI or bare HTTP library.
        for ua in [
            "curl/8.7.1",
            "okhttp/4.9.3",
            "Go-http-client/2.0",
            "",
            "python-requests/2.31",
        ] {
            assert_eq!(
                device_name_from_user_agent(ua),
                None,
                "unrecognized UA should not become a device name: {ua:?}",
            );
        }
    }

    #[test]
    fn a_lone_os_still_names_the_device() {
        // A UA with a recognizable platform but no known browser token.
        assert_eq!(
            device_name_from_user_agent("MyNativeApp/2.0 (Macintosh; Apple Silicon)").as_deref(),
            Some("macOS"),
        );
    }
}
