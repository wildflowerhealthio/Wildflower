//! The editable cloud content DTO + its validator — the pieces the cloud create /
//! replace capabilities share. [`CloudAppPayload`] is what the HTTP layer maps its
//! `CloudAppBody` onto (create + replace both carry it); [`validate_cloud_fields`] is
//! the write-side check both run before synthesizing the `(registration,
//! configuration)` the store persists.

use crate::domain::{AppUrl, AppsError};

/// The editable content of a cloud app — the fields `POST /cloud-apps` (create) and
/// `PUT /cloud-apps/{id}` (replace) both carry. The HTTP layer maps its `CloudAppBody`
/// onto this before calling the capability, which validates the fields and synthesizes
/// the `(registration, configuration)` it persists (the placement — `position` /
/// `on_homescreen` — is never part of content; `PUT /home-screen` owns it).
pub(crate) struct CloudAppPayload {
    pub name: String,
    /// `None` means "no subtitle"; an empty string clears it.
    pub subtitle: Option<String>,
    /// The launch URL template, validated through the write-side [`AppUrl`] filter.
    pub url: String,
    pub requires_tunnel: bool,
}

/// Validate the editable cloud fields: the name must be non-empty and the url must
/// parse through the write-side [`AppUrl`] filter. An empty subtitle (`""`) clears
/// it. `on_homescreen` has no place here — homescreen curation owns it.
///
/// # Errors
///
/// [`AppsError::InvalidName`] on an empty name; [`AppsError::InvalidUrl`] when the url
/// doesn't parse through the [`AppUrl`] filter.
pub(crate) fn validate_cloud_fields(
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

    /// The write-side validator the cloud create + replace capabilities share: an
    /// empty name is `InvalidName`, an unparseable url is `InvalidUrl`, and an empty
    /// subtitle clears to `None`.
    #[test]
    fn validate_cloud_fields_checks_name_and_url_and_clears_empty_subtitle() {
        assert!(matches!(
            validate_cloud_fields(String::new(), None, "https://x.example".to_owned()),
            Err(AppsError::InvalidName { .. })
        ));
        assert!(matches!(
            validate_cloud_fields("Name".to_owned(), None, "javascript:alert(1)".to_owned()),
            Err(AppsError::InvalidUrl { .. })
        ));
        let (name, subtitle, _url) = validate_cloud_fields(
            "Name".to_owned(),
            Some(String::new()),
            "https://x.example".to_owned(),
        )
        .expect("valid fields");
        assert_eq!(name, "Name");
        assert_eq!(subtitle, None, "an empty subtitle clears to None");
    }
}
