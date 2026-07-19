//! The self-hosted write-side helpers the install / replace capabilities share:
//! [`slugify`] derives the id / subdomain (a DNS label) from an app name, and
//! [`validate_launch_path`] checks a `launchPath` is origin-relative.

use crate::domain::AppsError;

/// Reduce an app name to a DNS label: lowercase, each run of non-alphanumerics
/// collapsed to a single `-`, trimmed, and capped at the 63-char label limit (a cut
/// at the boundary can land on a `-`, so a trailing one is stripped again). `None`
/// when nothing survives — the name has no usable slug. The label becomes the app's
/// id **and** its public subdomain, so it must be a valid DNS label.
pub(crate) fn slugify(name: &str) -> Option<String> {
    let mut slug = String::new();
    let mut pending_dash = false;
    for ch in name.chars() {
        let lower = ch.to_ascii_lowercase();
        if lower.is_ascii_alphanumeric() {
            slug.push(lower);
            pending_dash = false;
        } else if !pending_dash {
            slug.push('-');
            pending_dash = true;
        }
    }

    let trimmed = slug.trim_matches('-');
    let mut result: String = trimmed.chars().take(63).collect();
    while result.ends_with('-') {
        result.pop();
    }
    (!result.is_empty()).then_some(result)
}

/// Validate a `launchPath` value. A cleared value (`None` / empty) passes through
/// as `None`. A non-empty path must be origin-relative — start with a single `/`
/// (not `//`, a protocol-relative authority) — so it hangs safely off the app's
/// own origin at launch; anything else is a `400 InvalidUrl`.
///
/// # Errors
///
/// [`AppsError::InvalidUrl`] when a non-empty path isn't origin-relative.
pub(crate) fn validate_launch_path(value: Option<String>) -> Result<Option<String>, AppsError> {
    match value.filter(|s| !s.is_empty()) {
        None => Ok(None),
        Some(path) if path.starts_with('/') && !path.starts_with("//") => Ok(Some(path)),
        Some(_) => Err(AppsError::InvalidUrl {
            message: "launch path must be an origin-relative /path".to_owned(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_lowercases_and_collapses_separators() {
        assert_eq!(slugify("My Cool App!!"), Some("my-cool-app".to_owned()));
        assert_eq!(slugify("  Trim  Me  "), Some("trim-me".to_owned()));
        assert_eq!(
            slugify("under_score/slash"),
            Some("under-score-slash".to_owned())
        );
        assert_eq!(
            slugify("Already-Slugged"),
            Some("already-slugged".to_owned())
        );
    }

    #[test]
    fn slugify_returns_none_when_nothing_survives() {
        assert_eq!(slugify(""), None);
        assert_eq!(slugify("   "), None);
        assert_eq!(slugify("!!!"), None);
    }

    #[test]
    fn slugify_caps_at_dns_label_length_without_trailing_dash() {
        let long = "a".repeat(100);
        let slug = slugify(&long).unwrap();
        assert_eq!(slug.len(), 63);
        // A name that would cut on a separator at the boundary doesn't leave a
        // trailing dash.
        let boundary = format!("{}-tail", "b".repeat(62));
        let slug = slugify(&boundary).unwrap();
        assert!(slug.len() <= 63);
        assert!(!slug.ends_with('-'));
    }

    /// A cleared value (`None` / empty) passes through as `None`; an origin-relative
    /// `/path` is kept; an absolute or protocol-relative value is `InvalidUrl`.
    #[test]
    fn validate_launch_path_keeps_origin_relative_and_rejects_the_rest() {
        assert_eq!(validate_launch_path(None).unwrap(), None);
        assert_eq!(validate_launch_path(Some(String::new())).unwrap(), None);
        assert_eq!(
            validate_launch_path(Some("/launch.html".to_owned())).unwrap(),
            Some("/launch.html".to_owned()),
        );
        assert!(matches!(
            validate_launch_path(Some("https://evil.example/x".to_owned())),
            Err(AppsError::InvalidUrl { .. })
        ));
        assert!(matches!(
            validate_launch_path(Some("//evil.example/x".to_owned())),
            Err(AppsError::InvalidUrl { .. })
        ));
    }
}
