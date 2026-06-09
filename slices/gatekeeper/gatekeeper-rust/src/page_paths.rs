use url::form_urlencoded;

pub fn oauth_polling_path(id: &str) -> String {
    format!("/gatekeeper/oauth-polling/{}", percent_encode(id))
}

pub fn oauth_consent_path(id: &str) -> String {
    format!("/gatekeeper/oauth-consent/{}", percent_encode(id))
}

pub fn device_entry_path() -> &'static str {
    "/gatekeeper/devices"
}

pub fn device_consent_path(user_code: &str) -> String {
    format!("/gatekeeper/devices/{}", percent_encode(user_code))
}

pub fn oauth_polling_url(origin: &str, id: &str) -> String {
    format!("{origin}{}", oauth_polling_path(id))
}

pub fn oauth_consent_url(origin: &str, id: &str) -> String {
    format!("{origin}{}", oauth_consent_path(id))
}

pub fn device_entry_url(origin: &str) -> String {
    format!("{origin}{}", device_entry_path())
}

pub fn device_entry_url_with_code(origin: &str, user_code: &str) -> String {
    let query: String = form_urlencoded::Serializer::new(String::new())
        .append_pair("user_code", user_code)
        .finish();
    format!("{origin}{}?{}", device_entry_path(), query)
}

pub fn device_consent_url(origin: &str, user_code: &str) -> String {
    format!("{origin}{}", device_consent_path(user_code))
}

fn percent_encode(s: &str) -> String {
    form_urlencoded::byte_serialize(s.as_bytes())
        .collect::<String>()
        .replace('+', "%20")
}
