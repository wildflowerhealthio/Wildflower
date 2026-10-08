//! The rule for a server's domain: a bare `host[:port]` that, behind
//! `https://`, names an origin. [`public_origin_url`] applies it, for
//! consumers that need the origin as a URL (the server's FHIR `base_url` and an
//! app launch's `{origin}`).

use url::Url;

/// A domain that doesn't name an `https://` origin.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidDomain {
    pub domain: String,
    pub reason: String,
}

impl std::fmt::Display for InvalidDomain {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "domain {:?} is not a bare host name: {}",
            self.domain, self.reason
        )
    }
}

impl std::error::Error for InvalidDomain {}

/// The `https://{domain}` origin for a server's domain.
///
/// # Errors
///
/// [`InvalidDomain`] when `domain` is empty, carries anything beyond a
/// `host[:port]` (a scheme, path, query, fragment or credentials), or doesn't
/// parse as a host.
pub fn public_origin_url(domain: &str) -> Result<Url, InvalidDomain> {
    let invalid = |reason: &str| InvalidDomain {
        domain: domain.to_owned(),
        reason: reason.to_owned(),
    };
    if domain.is_empty() {
        return Err(invalid("it is empty"));
    }
    if let Some(found) = domain
        .chars()
        .find(|c| matches!(c, '/' | '\\' | '?' | '#' | '@') || c.is_whitespace())
    {
        return Err(invalid(&format!("it contains {found:?}")));
    }
    let origin =
        Url::parse(&format!("https://{domain}")).map_err(|error| invalid(&error.to_string()))?;
    if origin.host().is_none() {
        return Err(invalid("it has no host"));
    }
    Ok(origin)
}

#[cfg(test)]
mod tests {
    use super::public_origin_url;

    #[test]
    fn a_bare_host_names_its_https_origin() {
        let origin = public_origin_url("dev1.example.com").expect("valid host");
        assert_eq!(origin.as_str(), "https://dev1.example.com/");
    }

    #[test]
    fn a_host_with_a_port_keeps_the_port() {
        let origin = public_origin_url("dev1.example.com:8443").expect("valid host");
        assert_eq!(origin.port(), Some(8443));
    }

    #[test]
    fn anything_beyond_host_and_port_is_refused() {
        for refused in [
            "",
            "https://dev1.example.com",
            "dev1.example.com/fhir",
            "dev1.example.com?x=1",
            "dev1.example.com#top",
            "user@dev1.example.com",
            "dev1 example.com",
            "dev1.example.com:notaport",
            "[::1",
        ] {
            assert!(public_origin_url(refused).is_err(), "accepted {refused:?}");
        }
    }
}
