//! Paths of the gatekeeper's user-facing pages (the `/gatekeeper/*` routes of
//! the hosted owner UI), relative to the owner UI's root.
//! [`OwnerUiPages`](crate::http::extractors::OwnerUiPages) resolves them into
//! the absolute URLs a browser is sent to.

use url::form_urlencoded;

/// Owner-UI route of the OAuth polling page for authorization request `id`.
pub fn oauth_polling_path(id: &str) -> String {
    format!("/gatekeeper/oauth-polling/{}", percent_encode(id))
}

/// Owner-UI route of the device-flow code-entry page.
pub fn device_entry_path() -> &'static str {
    "/gatekeeper/devices"
}

fn percent_encode(s: &str) -> String {
    form_urlencoded::byte_serialize(s.as_bytes())
        .collect::<String>()
        .replace('+', "%20")
}

#[cfg(test)]
mod tests {
    use super::oauth_polling_path;

    #[test]
    fn oauth_polling_path_encodes_the_id_as_one_segment() {
        assert_eq!(
            oauth_polling_path("a/b c"),
            "/gatekeeper/oauth-polling/a%2Fb%20c"
        );
    }
}
