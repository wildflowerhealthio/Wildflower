pub enum OAuthErrorKind {
    UnsupportedCodeChallenge,
    InvalidRedirectUri,
    InvalidScheme,
    UnknownClient,
    DisabledClient,
    RedirectUriNotAllowed,
    ScopeNotAllowed,
}

fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn title_and_body(kind: &OAuthErrorKind) -> (&'static str, &'static str) {
    match kind {
        OAuthErrorKind::UnsupportedCodeChallenge => (
            "Unsupported code challenge method",
            "Only S256 code_challenge_method is supported",
        ),
        OAuthErrorKind::InvalidRedirectUri => (
            "Invalid redirect URI",
            "The supplied redirect_uri is not a well-formed URL.",
        ),
        OAuthErrorKind::InvalidScheme => (
            "Invalid redirect URI scheme",
            "The supplied redirect_uri must use http or https.",
        ),
        OAuthErrorKind::UnknownClient => (
            "Unknown client",
            "The supplied client_id is not registered.",
        ),
        OAuthErrorKind::DisabledClient => (
            "Disabled client",
            "The supplied client_id has been disabled.",
        ),
        OAuthErrorKind::RedirectUriNotAllowed => (
            "Redirect URI not allowed",
            "The supplied redirect_uri is not registered for this client.",
        ),
        OAuthErrorKind::ScopeNotAllowed => (
            "Scope not allowed",
            "One or more requested scopes are not permitted for this client.",
        ),
    }
}

pub fn oauth_error_html(kind: OAuthErrorKind, method: Option<&str>) -> String {
    let (title, body) = title_and_body(&kind);
    let suffix = match (&kind, method) {
        (OAuthErrorKind::UnsupportedCodeChallenge, Some(m)) => format!(" (received: {})", escape(m)),
        _ => String::new(),
    };
    format!(
        "<!doctype html>\n\
<html lang=\"en\">\n\
<head>\n\
  <meta charset=\"utf-8\">\n\
  <title>{title}</title>\n\
</head>\n\
<body>\n\
  <h1>{title}</h1>\n\
  <p>{body}{suffix}.</p>\n\
</body>\n\
</html>"
    )
}
