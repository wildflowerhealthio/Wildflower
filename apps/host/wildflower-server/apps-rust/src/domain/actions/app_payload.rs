//! The editable app content DTO + its validator — the pieces the create / replace
//! capabilities share. [`AppPayload`] is what the HTTP layer maps its `AppBody`
//! onto (create + replace both carry it); [`validate_app_fields`] is the write-side
//! check both run before synthesizing the registration the store persists.

use crate::domain::{AppUrl, AppsError};

/// The editable content of an app — the fields `POST /apps` (create) and
/// `PUT /apps/{id}` (replace) both carry. The HTTP layer maps its `AppBody` onto
/// this before calling the capability, which validates the fields and synthesizes
/// the registration it persists (the placement — `position` / `on_homescreen` — is
/// never part of content; `PUT /home-screen` owns it).
pub(crate) struct AppPayload {
    pub name: String,
    /// `None` means "no subtitle"; an empty string clears it.
    pub subtitle: Option<String>,
    /// The launch URL template, validated through the write-side [`AppUrl`] filter.
    pub url: String,
    pub requires_tunnel: bool,
}

/// Validate the editable app fields: the name must be non-empty and the url must
/// parse through the write-side [`AppUrl`] filter. An empty subtitle (`""`) clears
/// it. `on_homescreen` has no place here — homescreen curation owns it.
///
/// # Errors
///
/// [`AppsError::InvalidName`] on an empty name; [`AppsError::InvalidUrl`] when the url
/// doesn't parse through the [`AppUrl`] filter.
pub(crate) fn validate_app_fields(
    name: String,
    subtitle: Option<String>,
    url: String,
) -> Result<(String, Option<String>, AppUrl), AppsError> {
    if name.is_empty() {
        return Err(AppsError::InvalidName {
            message: "name must not be empty".to_owned(),
        });
    }
    let url = url.parse::<AppUrl>().map_err(|e| AppsError::InvalidUrl {
        message: e.to_string(),
    })?;
    Ok((name, subtitle.filter(|s| !s.is_empty()), url))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The write-side validator the create + replace capabilities share: an empty
    /// name is `InvalidName`, an unparseable url is `InvalidUrl`, and an empty
    /// subtitle clears to `None`.
    #[test]
    fn validate_app_fields_checks_name_and_url_and_clears_empty_subtitle() {
        assert!(matches!(
            validate_app_fields(String::new(), None, "https://x.example".to_owned()),
            Err(AppsError::InvalidName { .. })
        ));
        assert!(matches!(
            validate_app_fields("Name".to_owned(), None, "javascript:alert(1)".to_owned()),
            Err(AppsError::InvalidUrl { .. })
        ));
        let (name, subtitle, _url) = validate_app_fields(
            "Name".to_owned(),
            Some(String::new()),
            "https://x.example".to_owned(),
        )
        .expect("valid fields");
        assert_eq!(name, "Name");
        assert_eq!(subtitle, None, "an empty subtitle clears to None");
    }
}
