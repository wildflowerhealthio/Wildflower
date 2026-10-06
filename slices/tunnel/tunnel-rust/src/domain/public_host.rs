//! The rule for a tunnel public host: a bare `host[:port]` that, behind
//! `https://`, names an origin. [`public_origin_url`] applies it, for
//! consumers that need the origin as a URL (the server's FHIR `base_url` and an
//! app launch's `{origin}`).

use url::Url;

/// A public host that doesn't name an `https://` origin.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidPublicHost {
    pub public_host: String,
    pub reason: String,
}

impl std::fmt::Display for InvalidPublicHost {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "public host {:?} is not a bare host name: {}",
            self.public_host, self.reason
        )
    }
}

impl std::error::Error for InvalidPublicHost {}

/// The `https://{public_host}` origin for a public host.
///
/// # Errors
///
/// [`InvalidPublicHost`] when `public_host` is empty, carries anything beyond a
/// `host[:port]` (a scheme, path, query, fragment or credentials), or doesn't
/// parse as a host.
pub fn public_origin_url(public_host: &str) -> Result<Url, InvalidPublicHost> {
    let invalid = |reason: &str| InvalidPublicHost {
        public_host: public_host.to_owned(),
        reason: reason.to_owned(),
    };
    if public_host.is_empty() {
        return Err(invalid("it is empty"));
    }
    if let Some(found) = public_host
        .chars()
        .find(|c| matches!(c, '/' | '\\' | '?' | '#' | '@') || c.is_whitespace())
    {
        return Err(invalid(&format!("it contains {found:?}")));
    }
    let origin = Url::parse(&format!("https://{public_host}"))
        .map_err(|error| invalid(&error.to_string()))?;
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
