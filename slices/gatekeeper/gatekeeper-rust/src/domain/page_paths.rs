//! URL/path builders for the gatekeeper's user-facing webview pages (the
//! `/gatekeeper/*` routes the host app renders). The `*_path` helpers return
//! the origin-relative path; the `*_url` helpers prepend a caller-supplied
//! origin (typically the per-request served origin the
//! [`served_base_url_for`](crate::http::served_base_url_for) resolver feeds) to
//! produce an absolute URL for redirects and consent links.

use url::form_urlencoded;

/// Origin-relative path of the OAuth polling page for authorization request `id`.
pub fn oauth_polling_path(id: &str) -> String {
    format!("/gatekeeper/oauth-polling/{}", percent_encode(id))
}

/// Origin-relative path of the device-flow code-entry page.
pub fn device_entry_path() -> &'static str {
    "/gatekeeper/devices"
}

/// Absolute URL of the OAuth polling page for `id`, rooted at `origin`.
pub fn oauth_polling_url(origin: &str, id: &str) -> String {
    format!("{origin}{}", oauth_polling_path(id))
}

/// Absolute URL of the device-flow code-entry page, rooted at `origin`.
pub fn device_entry_url(origin: &str) -> String {
    format!("{origin}{}", device_entry_path())
}

/// Absolute URL of the device-flow code-entry page with `user_code` pre-filled
/// in the query string, rooted at `origin`.
pub fn device_entry_url_with_code(origin: &str, user_code: &str) -> String {
    let query: String = form_urlencoded::Serializer::new(String::new())
        .append_pair("user_code", user_code)
        .finish();
    format!("{origin}{}?{}", device_entry_path(), query)
}

fn percent_encode(s: &str) -> String {
    form_urlencoded::byte_serialize(s.as_bytes())
        .collect::<String>()
        .replace('+', "%20")
}
