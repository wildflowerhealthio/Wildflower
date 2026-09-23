//! URL/path builders for the gatekeeper's user-facing pages (the
//! `/gatekeeper/*` routes of the hosted owner UI). The `*_path` helpers return
//! the owner-UI-relative route; the `*_url` helpers resolve it on the hosted
//! owner UI ([`OwnerUiBase`]) pointed at `server_origin` — typically the
//! per-request served origin from
//! [`served_base_url_for`](crate::http::served_base_url_for).

use shared_structures_rust::owner_ui::OwnerUiBase;
use url::form_urlencoded;

/// Owner-UI route of the OAuth polling page for authorization request `id`.
pub fn oauth_polling_path(id: &str) -> String {
    format!("/gatekeeper/oauth-polling/{}", percent_encode(id))
}

/// Owner-UI route of the device-flow code-entry page.
pub fn device_entry_path() -> &'static str {
    "/gatekeeper/devices"
}

/// Absolute URL of the OAuth polling page for `id`, on the hosted owner UI,
/// pointed at `server_origin`.
pub fn oauth_polling_url(owner_ui: &OwnerUiBase, server_origin: &str, id: &str) -> String {
    owner_ui
        .route_url(&oauth_polling_path(id), server_origin, &[])
        .into()
}

/// Absolute URL of the device-flow code-entry page, on the hosted owner UI,
/// pointed at `server_origin`.
pub fn device_entry_url(owner_ui: &OwnerUiBase, server_origin: &str) -> String {
    owner_ui
        .route_url(device_entry_path(), server_origin, &[])
        .into()
}

/// Absolute URL of the device-flow code-entry page with `user_code` pre-filled
/// in the query string, on the hosted owner UI, pointed at `server_origin`.
pub fn device_entry_url_with_code(
    owner_ui: &OwnerUiBase,
    server_origin: &str,
    user_code: &str,
) -> String {
    owner_ui
        .route_url(
            device_entry_path(),
            server_origin,
            &[("user_code", user_code)],
        )
        .into()
}

fn percent_encode(s: &str) -> String {
    form_urlencoded::byte_serialize(s.as_bytes())
        .collect::<String>()
        .replace('+', "%20")
}

#[cfg(test)]
mod tests {
    use super::{device_entry_url, device_entry_url_with_code, oauth_polling_url};
    use shared_structures_rust::owner_ui::OwnerUiBase;

    const SERVER: &str = "https://abc.tunnel.example";

    fn owner_ui() -> OwnerUiBase {
        OwnerUiBase::parse("https://owner-ui.test/app/").expect("valid base")
    }

    #[test]
    fn device_entry_urls_land_on_the_hosted_ui_pointed_at_the_server() {
        assert_eq!(
            device_entry_url(&owner_ui(), SERVER),
            "https://owner-ui.test/app/gatekeeper/devices?server=https%3A%2F%2Fabc.tunnel.example"
        );
        assert_eq!(
            device_entry_url_with_code(&owner_ui(), SERVER, "WXYZ-2345"),
            "https://owner-ui.test/app/gatekeeper/devices\
             ?server=https%3A%2F%2Fabc.tunnel.example&user_code=WXYZ-2345"
        );
    }

    #[test]
    fn oauth_polling_url_encodes_the_id_as_one_segment() {
        assert_eq!(
            oauth_polling_url(&owner_ui(), SERVER, "a/b c"),
            "https://owner-ui.test/app/gatekeeper/oauth-polling/a%2Fb%20c\
             ?server=https%3A%2F%2Fabc.tunnel.example"
        );
    }
}
