//! [`CertificateState`]: what the host knows about a server's certificate for
//! its public host, and [`CertificateRun`], the reducer a run derives it with
//! from its certificate's events.
//!
//! A running server's state comes from its run, as rustls-acme deploys,
//! orders and renews the certificate; a stopped server's from the certificate
//! cached in its `certificates/` folder:
//!
//! ```text
//!                      issued certificate         order error since
//!   running            none     valid  ⅓ left  expired   the last deploy
//!     status         Ordering   Valid  RenewalDue  Ordering        no
//!                    Failed     Valid  RenewalDue  Failed          yes
//!   stopped          None       Valid  RenewalDue  Expired         —
//! ```
//!
//! A stopped server's certificate lapses, since nothing renews it, and the
//! next start orders a new one: `Expired` is only ever a stopped server's
//! status, and never a failure.

use chrono::{DateTime, Utc};

use crate::CertificateAuthority;

/// A certificate the CA issued for the server's public host: when it is
/// valid, and which certificate it is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssuedCertificate {
    /// When the certificate became valid.
    pub not_before: DateTime<Utc>,
    /// When the certificate expires.
    pub not_after: DateTime<Utc>,
    /// The SHA-256 of the leaf certificate's DER, in lowercase hex: the
    /// fingerprint Certificate Transparency logs list it by.
    pub fingerprint: String,
}

impl IssuedCertificate {
    /// When a third of the certificate's lifetime is left: when rustls-acme
    /// orders its successor.
    #[must_use]
    pub fn renewal_due_at(&self) -> DateTime<Utc> {
        self.not_after - (self.not_after - self.not_before) / 3
    }
}

/// Where a server's certificate stands (see the [module docs](self)).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CertificateStatus {
    /// A stopped server holds no certificate from its CA: it has never been
    /// issued one, or the record names another CA than the one it was.
    None,
    /// The run is ordering a certificate: it holds none, or an expired one,
    /// and no order has failed yet.
    Ordering,
    /// The certificate is valid, with more than a third of its lifetime
    /// left.
    Valid,
    /// The certificate is valid, with a third or less of its lifetime left: a
    /// run is ordering its successor, and a stopped server's run will.
    RenewalDue,
    /// A stopped server's certificate has expired. It renews when the server
    /// starts; a running server's expired certificate is `Ordering` or
    /// `Failed`.
    Expired,
    /// The run holds no valid certificate, and its latest order failed with
    /// the state's [`last_error`](CertificateState::last_error). rustls-acme
    /// retries it, with backoff.
    Failed,
}

/// Why a certificate order failed, in terms the base can phrase.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CertificateOrderError {
    /// The CA refused the order under one of its rate limits.
    RateLimited {
        /// When the CA said to retry, when it said.
        retry_after: Option<DateTime<Utc>>,
    },
    /// The CA's validation handshake didn't reach this device, or got the
    /// wrong answer: the relay, the tunnel or the server's run wasn't up.
    ChallengeFailed {
        /// The CA's explanation, when it gave one.
        detail: Option<String>,
    },
    /// The CA's API couldn't be reached, or answered without an ACME problem
    /// document.
    CaUnreachable {
        /// The error, for the log and the base's details.
        message: String,
    },
    /// Any other failure: an ACME problem the base has no phrasing for, or a
    /// fault on this device, such as a certificate cache it can't write.
    Other {
        /// The error, for the log and the base's details.
        message: String,
    },
}

/// What the host knows about a server's certificate for its public host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CertificateState {
    /// Where the certificate stands.
    pub status: CertificateStatus,
    /// The CA the certificate is ordered from, as the server's record names
    /// it.
    pub issuer: CertificateAuthority,
    /// The certificate the server holds from `issuer`, valid or expired.
    pub issued: Option<IssuedCertificate>,
    /// Why the run's latest order failed, since it last deployed a
    /// certificate. Always `None` for a stopped server.
    pub last_error: Option<CertificateOrderError>,
}

impl CertificateState {
    /// The state of a stopped server whose cache holds `cached` from
    /// `issuer`, at `now`: `None`, `Valid`, `RenewalDue` or `Expired`, never
    /// `Ordering` or `Failed`.
    #[must_use]
    pub fn of_stopped_server(
        cached: Option<IssuedCertificate>,
        issuer: CertificateAuthority,
        now: DateTime<Utc>,
    ) -> Self {
        let status = match &cached {
            None => CertificateStatus::None,
            Some(issued) => match Validity::of(issued, now) {
                Validity::Valid => CertificateStatus::Valid,
                Validity::RenewalDue => CertificateStatus::RenewalDue,
                Validity::Expired => CertificateStatus::Expired,
            },
        };
        Self {
            status,
            issuer,
            issued: cached,
            last_error: None,
        }
    }
}

/// How far into its lifetime a certificate is at an instant.
enum Validity {
    Valid,
    RenewalDue,
    Expired,
}

impl Validity {
    fn of(issued: &IssuedCertificate, now: DateTime<Utc>) -> Self {
        if now >= issued.not_after {
            Self::Expired
        } else if now >= issued.renewal_due_at() {
            Self::RenewalDue
        } else {
            Self::Valid
        }
    }
}

/// What a run's certificate did, as the run reads it from rustls-acme's
/// events.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CertificateEvent {
    /// The run deployed this certificate: the cached one at start, or a newly
    /// issued one.
    Deployed(IssuedCertificate),
    /// An order failed, or the cache couldn't be read or written.
    Failed(CertificateOrderError),
}

/// What a run has seen of its certificate: the one it holds and the latest
/// failure since it was deployed. Derives the run's [`CertificateState`] at
/// any instant, and when that state next changes without an event.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct CertificateRun {
    issued: Option<IssuedCertificate>,
    last_error: Option<CertificateOrderError>,
}

impl CertificateRun {
    /// A run starting with `cached` in its certificate cache, before
    /// rustls-acme has deployed it.
    pub(crate) fn starting_with(cached: Option<IssuedCertificate>) -> Self {
        Self {
            issued: cached,
            last_error: None,
        }
    }

    /// The run after `event`. A deployed certificate clears the last error.
    #[must_use]
    pub(crate) fn after(self, event: CertificateEvent) -> Self {
        match event {
            CertificateEvent::Deployed(issued) => Self {
                issued: Some(issued),
                last_error: None,
            },
            CertificateEvent::Failed(error) => Self {
                last_error: Some(error),
                ..self
            },
        }
    }

    /// The run's state at `now`, its certificate from `issuer`.
    pub(crate) fn state(
        &self,
        issuer: CertificateAuthority,
        now: DateTime<Utc>,
    ) -> CertificateState {
        let ordering_or_failed = if self.last_error.is_some() {
            CertificateStatus::Failed
        } else {
            CertificateStatus::Ordering
        };
        let status = match &self.issued {
            None => ordering_or_failed,
            Some(issued) => match Validity::of(issued, now) {
                Validity::Valid => CertificateStatus::Valid,
                Validity::RenewalDue => CertificateStatus::RenewalDue,
                Validity::Expired => ordering_or_failed,
            },
        };
        CertificateState {
            status,
            issuer,
            issued: self.issued.clone(),
            last_error: self.last_error.clone(),
        }
    }

    /// The next instant after `now` at which the run's state changes with no
    /// event: when its certificate's renewal falls due, then when it expires.
    pub(crate) fn next_status_change(&self, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
        let issued = self.issued.as_ref()?;
        [issued.renewal_due_at(), issued.not_after]
            .into_iter()
            .find(|instant| *instant > now)
    }
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;

    use super::*;

    const ISSUER: CertificateAuthority = CertificateAuthority::LetsEncrypt;

    fn on(month: u32, day: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, month, day, 0, 0, 0).unwrap()
    }

    /// A 90-day certificate from 1 January: its renewal falls due on
    /// 2 March, when 30 days are left, and it expires on 1 April.
    fn ninety_day(fingerprint: &str) -> IssuedCertificate {
        IssuedCertificate {
            not_before: on(1, 1),
            not_after: on(4, 1),
            fingerprint: fingerprint.to_owned(),
        }
    }

    fn rate_limited() -> CertificateOrderError {
        CertificateOrderError::RateLimited { retry_after: None }
    }

    #[test]
    fn renewal_falls_due_with_a_third_of_the_lifetime_left() {
        assert_eq!(ninety_day("a").renewal_due_at(), on(3, 2));
    }

    #[test]
    fn a_run_with_nothing_cached_is_ordering_until_its_first_deploy() {
        let run = CertificateRun::starting_with(None);
        assert_eq!(
            run.state(ISSUER, on(1, 2)).status,
            CertificateStatus::Ordering
        );

        let run = run.after(CertificateEvent::Deployed(ninety_day("a")));
        let state = run.state(ISSUER, on(1, 2));
        assert_eq!(state.status, CertificateStatus::Valid);
        assert_eq!(state.issued, Some(ninety_day("a")));
        assert_eq!(state.issuer, ISSUER);
    }

    #[test]
    fn a_failed_first_order_is_failed_until_a_deploy_clears_it() {
        let run =
            CertificateRun::starting_with(None).after(CertificateEvent::Failed(rate_limited()));
        let state = run.state(ISSUER, on(1, 2));
        assert_eq!(state.status, CertificateStatus::Failed);
        assert_eq!(state.last_error, Some(rate_limited()));

        let run = run.after(CertificateEvent::Deployed(ninety_day("a")));
        let state = run.state(ISSUER, on(1, 2));
        assert_eq!(state.status, CertificateStatus::Valid);
        assert_eq!(state.last_error, None);
    }

    #[test]
    fn a_run_s_certificate_falls_due_for_renewal_then_is_reordered_once_expired() {
        let run = CertificateRun::starting_with(Some(ninety_day("a")));
        assert_eq!(run.state(ISSUER, on(3, 1)).status, CertificateStatus::Valid);
        assert_eq!(
            run.state(ISSUER, on(3, 2)).status,
            CertificateStatus::RenewalDue
        );
        let expired = on(4, 1);
        assert_eq!(
            run.state(ISSUER, expired).status,
            CertificateStatus::Ordering
        );
    }

    #[test]
    fn a_failed_renewal_stays_renewal_due_with_its_error_until_the_certificate_expires() {
        let run = CertificateRun::starting_with(Some(ninety_day("a")))
            .after(CertificateEvent::Failed(rate_limited()));
        let state = run.state(ISSUER, on(3, 2));
        assert_eq!(state.status, CertificateStatus::RenewalDue);
        assert_eq!(state.last_error, Some(rate_limited()));
        let expired = on(4, 1);
        assert_eq!(run.state(ISSUER, expired).status, CertificateStatus::Failed);
    }

    #[test]
    fn a_renewal_replaces_the_certificate() {
        let renewed = IssuedCertificate {
            not_before: on(3, 2),
            not_after: on(5, 31),
            fingerprint: "b".to_owned(),
        };
        let run = CertificateRun::starting_with(Some(ninety_day("a")))
            .after(CertificateEvent::Deployed(renewed.clone()));
        let state = run.state(ISSUER, on(3, 2));
        assert_eq!(state.status, CertificateStatus::Valid);
        assert_eq!(state.issued, Some(renewed));
    }

    #[test]
    fn the_state_next_changes_at_renewal_then_at_expiry_then_never() {
        let run = CertificateRun::starting_with(Some(ninety_day("a")));
        assert_eq!(run.next_status_change(on(1, 2)), Some(on(3, 2)));
        assert_eq!(run.next_status_change(on(3, 2)), Some(on(4, 1)));
        let expired = on(4, 1);
        assert_eq!(run.next_status_change(expired), None);
        assert_eq!(CertificateRun::default().next_status_change(on(1, 2)), None);
    }

    #[test]
    fn a_stopped_server_s_lapsed_certificate_is_expired_not_failed() {
        let expired = on(6, 1);
        let state = CertificateState::of_stopped_server(Some(ninety_day("a")), ISSUER, expired);
        assert_eq!(state.status, CertificateStatus::Expired);
        assert_eq!(state.last_error, None);
    }

    #[test]
    fn a_stopped_server_reads_none_valid_or_renewal_due() {
        assert_eq!(
            CertificateState::of_stopped_server(None, ISSUER, on(1, 2)).status,
            CertificateStatus::None
        );
        assert_eq!(
            CertificateState::of_stopped_server(Some(ninety_day("a")), ISSUER, on(1, 2)).status,
            CertificateStatus::Valid
        );
        assert_eq!(
            CertificateState::of_stopped_server(Some(ninety_day("a")), ISSUER, on(3, 2)).status,
            CertificateStatus::RenewalDue
        );
    }
}
