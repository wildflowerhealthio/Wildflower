//! [`CertificateAuthority`]: the ACME CA a server's certificates are ordered
//! from, as its record names it.

use serde::{Deserialize, Serialize};
use url::Url;

/// Which ACME CA a server's certificates are ordered from. Written in
/// camelCase, `"letsEncryptStaging"` or `"letsEncrypt"`, in `servers.json`
/// and on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CertificateAuthority {
    /// Let's Encrypt's staging CA: its certificates aren't publicly trusted,
    /// and its rate limits are far higher than production's.
    LetsEncryptStaging,
    /// Let's Encrypt's production CA: publicly trusted certificates.
    LetsEncrypt,
}

impl CertificateAuthority {
    /// The CA's ACME directory, which a run orders its certificate from.
    ///
    /// # Panics
    ///
    /// Never: both directories are rustls-acme's constant URLs, which a test
    /// parses.
    #[must_use]
    pub fn directory_url(self) -> Url {
        let directory_url = match self {
            Self::LetsEncryptStaging => rustls_acme::acme::LETS_ENCRYPT_STAGING_DIRECTORY,
            Self::LetsEncrypt => rustls_acme::acme::LETS_ENCRYPT_PRODUCTION_DIRECTORY,
        };
        Url::parse(directory_url).expect("rustls-acme's Let's Encrypt directories are URLs")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_ca_names_its_let_s_encrypt_directory() {
        assert_eq!(
            CertificateAuthority::LetsEncryptStaging
                .directory_url()
                .as_str(),
            "https://acme-staging-v02.api.letsencrypt.org/directory"
        );
        assert_eq!(
            CertificateAuthority::LetsEncrypt.directory_url().as_str(),
            "https://acme-v02.api.letsencrypt.org/directory"
        );
    }

    #[test]
    fn each_ca_is_written_in_camel_case() {
        assert_eq!(
            serde_json::to_value(CertificateAuthority::LetsEncryptStaging).unwrap(),
            "letsEncryptStaging"
        );
        assert_eq!(
            serde_json::to_value(CertificateAuthority::LetsEncrypt).unwrap(),
            "letsEncrypt"
        );
    }
}
