//! URL/path builders for the gatekeeper's user-facing pages (the
//! `/gatekeeper/*` routes of the hosted launcher). The `*_path` helpers return
//! the launcher-relative route; the `*_url` helpers resolve it on the hosted
//! launcher ([`LauncherBase`]) pointed at `served_origin` — typically the
//! per-request served origin from
//! [`served_base_url_for`](shared_structures_rust::served_origin::served_base_url_for).

use shared_structures_rust::launcher::LauncherBase;

/// Launcher route of the device-flow code-entry page.
pub fn device_entry_path() -> &'static str {
    "/gatekeeper/devices"
}

/// Absolute URL of the device-flow code-entry page, on the hosted launcher,
/// pointed at `served_origin`.
pub fn device_entry_url(launcher: &LauncherBase, served_origin: &str) -> String {
    launcher
        .route_url(device_entry_path(), served_origin, &[])
        .into()
}

/// Absolute URL of the device-flow code-entry page with `user_code` pre-filled
/// in the query string, on the hosted launcher, pointed at `served_origin`.
pub fn device_entry_url_with_code(
    launcher: &LauncherBase,
    served_origin: &str,
    user_code: &str,
) -> String {
    launcher
        .route_url(
            device_entry_path(),
            served_origin,
            &[("user_code", user_code)],
        )
        .into()
}

#[cfg(test)]
mod tests {
    use super::{device_entry_url, device_entry_url_with_code};
    use shared_structures_rust::launcher::LauncherBase;

    const SERVER: &str = "https://abc.tunnel.example";

    fn launcher() -> LauncherBase {
        LauncherBase::parse("https://launcher.test/launcher/").expect("valid base")
    }

    #[test]
    fn device_entry_urls_land_on_the_hosted_ui_pointed_at_the_server() {
        assert_eq!(
            device_entry_url(&launcher(), SERVER),
            "https://launcher.test/launcher/gatekeeper/devices?server=https%3A%2F%2Fabc.tunnel.example"
        );
        assert_eq!(
            device_entry_url_with_code(&launcher(), SERVER, "WXYZ-2345"),
            "https://launcher.test/launcher/gatekeeper/devices\
             ?server=https%3A%2F%2Fabc.tunnel.example&user_code=WXYZ-2345"
        );
    }
}
