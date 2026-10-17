//! [`CertificateAuthority`]: the ACME CA a server's certificates are ordered
//! from, as its record names it.

use serde::{Deserialize, Serialize};
use url::Url;

/// How far back a CA's duplicate-certificate limit counts
/// ([`CertificateAuthority::duplicate_certificate_limit`]): Let's Encrypt's
/// 7 days.
pub(crate) const DUPLICATE_CERTIFICATE_WINDOW: chrono::TimeDelta = chrono::TimeDelta::days(7);

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
    /// A CA only tests order from, with the `test-support` feature: its
    /// directory is on this machine, at a port nothing listens on, so an order
    /// fails at once, and the state and history a test reads name it as the
    /// issuer rather than a real CA it never reached.
    #[cfg(feature = "test-support")]
    UnreachableForTests,
    /// A CA only tests order from, with the `test-support` feature: a fake
    /// ACME server the test runs on this machine at `port`, over plain HTTP,
    /// so a test can watch a run order and deploy a certificate.
    #[cfg(feature = "test-support")]
    LocalForTests {
        /// The port the fake ACME server listens on, at `127.0.0.1`.
        port: u16,
    },
}

impl CertificateAuthority {
    /// The CA's ACME directory, which a run orders its certificate from.
    ///
    /// # Panics
    ///
    /// Never: each directory is a constant URL, which a test parses.
    #[must_use]
    pub fn directory_url(self) -> Url {
        let directory_url = match self {
            Self::LetsEncryptStaging => rustls_acme::acme::LETS_ENCRYPT_STAGING_DIRECTORY,
            Self::LetsEncrypt => rustls_acme::acme::LETS_ENCRYPT_PRODUCTION_DIRECTORY,
            #[cfg(feature = "test-support")]
            Self::UnreachableForTests => "https://127.0.0.1:9/directory",
            #[cfg(feature = "test-support")]
            Self::LocalForTests { port } => {
                return Url::parse(&format!("http://127.0.0.1:{port}/directory"))
                    .expect("a local directory is a URL");
            }
        };
        Url::parse(directory_url).expect("rustls-acme's Let's Encrypt directories are URLs")
    }

    /// How many certificates for the same exact name the CA issues in
    /// [`DUPLICATE_CERTIFICATE_WINDOW`]: Let's Encrypt's production CA issues
    /// 5. `None` for a CA whose limit is far beyond what a server orders, as
    /// staging's is.
    #[must_use]
    pub fn duplicate_certificate_limit(self) -> Option<usize> {
        match self {
            Self::LetsEncrypt => Some(5),
            Self::LetsEncryptStaging => None,
            #[cfg(feature = "test-support")]
            Self::UnreachableForTests | Self::LocalForTests { .. } => None,
        }
    }

    /// Whether browsers trust the CA's certificates: an app's browser
    /// accepts a server's certificate only from a CA they trust. Only Let's
    /// Encrypt's production CA is.
    #[must_use]
    pub fn is_browser_trusted(self) -> bool {
        match self {
            Self::LetsEncrypt => true,
            Self::LetsEncryptStaging => false,
            #[cfg(feature = "test-support")]
            Self::UnreachableForTests | Self::LocalForTests { .. } => false,
        }
    }

    /// The CA's name in a sentence, such as "Let's Encrypt's staging CA".
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Self::LetsEncryptStaging => "Let's Encrypt's staging CA",
            Self::LetsEncrypt => "Let's Encrypt",
            #[cfg(feature = "test-support")]
            Self::UnreachableForTests => "the tests' unreachable CA",
            #[cfg(feature = "test-support")]
            Self::LocalForTests { .. } => "the tests' local CA",
        }
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
        assert_eq!(
            CertificateAuthority::UnreachableForTests
                .directory_url()
                .as_str(),
            "https://127.0.0.1:9/directory"
        );
    }

    #[test]
    fn only_let_s_encrypt_s_production_ca_is_browser_trusted() {
        assert!(CertificateAuthority::LetsEncrypt.is_browser_trusted());
        assert!(!CertificateAuthority::LetsEncryptStaging.is_browser_trusted());
        assert!(!CertificateAuthority::UnreachableForTests.is_browser_trusted());
    }

    #[test]
    fn only_let_s_encrypt_s_production_ca_has_a_duplicate_certificate_limit() {
        assert_eq!(
            CertificateAuthority::LetsEncrypt.duplicate_certificate_limit(),
            Some(5)
        );
        assert_eq!(
            CertificateAuthority::LetsEncryptStaging.duplicate_certificate_limit(),
            None
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
