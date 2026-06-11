//! Local HTML error pages for `/oauth/authorize` failures that may NOT be
//! redirected back to the client. RFC 6749 §4.1.2.1 restricts these to
//! `redirect_uri`/`client_id` validation failures — every other spec'd
//! error is delivered by redirecting to the (already validated)
//! `redirect_uri` with `error` + `state` query params instead.

pub enum OAuthErrorKind {
    InvalidRedirectUri,
    InvalidScheme,
    UnknownClient,
    DisabledClient,
    RedirectUriNotAllowed,
}

fn title_and_body(kind: &OAuthErrorKind) -> (&'static str, &'static str) {
    match kind {
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
    }
}

pub fn oauth_error_html(kind: OAuthErrorKind) -> String {
    let (title, body) = title_and_body(&kind);
    format!(
        "<!doctype html>\n\
<html lang=\"en\">\n\
<head>\n\
  <meta charset=\"utf-8\">\n\
  <title>{title}</title>\n\
</head>\n\
<body>\n\
  <h1>{title}</h1>\n\
  <p>{body}</p>\n\
</body>\n\
</html>"
    )
}
