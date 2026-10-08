//! [`CertificateState`]: what the host knows about a server's certificate for
//! its domain, and [`ObservedCertificate`], what a run has observed of its
//! certificate through rustls-acme's events, which its state is derived from.
//!
//! A running server's state is derived from what its run observed, as
//! rustls-acme deploys, orders and renews the certificate; any other
//! server's is what its cache says, read from its `certificates/` folder:
//!
//! ```text
//!          held certificate                                   latest error since
//!          none          valid            ⅓ left      expired       the last deploy
//!   run    Ordering      NoRenewalNeeded  RenewalDue  Ordering      none, or the cache's
//!          OrderFailing  NoRenewalNeeded  RenewalDue  OrderFailing  an order's
//!   cache  NotIssued     NoRenewalNeeded  RenewalDue  Expired       —
//! ```
//!
//! A cache fault is recorded as the last error but never makes a run
//! `OrderFailing`: rustls-acme keeps ordering, and that order may succeed.
//!
//! A stopped server's certificate lapses, since nothing renews it, and the
//! next start orders a new one: `Expired` is only ever the cache's status,
//! and never a failure.

use chrono::{DateTime, Utc};

use crate::CertificateAuthority;

/// A certificate the CA issued for the server's domain: when it is valid, and
/// which certificate it is.
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
    ///
    /// # Remarks
    ///
    /// This mirrors the renewal timer rustls-acme 0.15's `AcmeState` sets in
    /// `state.rs`, which waits until a third of the lifetime is left; if
    /// rustls-acme changes that threshold, this must change with it.
    #[must_use]
    pub fn renewal_due_at(&self) -> DateTime<Utc> {
        self.not_after - (self.not_after - self.not_before) / 3
    }
}

/// Where a server's certificate stands (see the [module docs](self)).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CertificateStatus {
    /// The cache holds no certificate from the server's CA: it has never been
    /// issued one, or the record names another CA than the one it was.
    NotIssued,
    /// The run is ordering a certificate: it holds none, or an expired one,
    /// and its latest error, if any, is the cache's rather than an order's.
    Ordering,
    /// The certificate is valid, with more than a third of its lifetime
    /// left: nothing orders its successor yet.
    NoRenewalNeeded,
    /// The certificate is valid, with a third or less of its lifetime left: a
    /// run is ordering its successor, and a stopped server's next run will.
    RenewalDue,
    /// The cache's certificate has expired. It renews when the server starts;
    /// a running server's expired certificate is `Ordering` or
    /// `OrderFailing`.
    Expired,
    /// The run holds no valid certificate, and its latest error is an order's
    /// failure, the state's [`last_error`](CertificateState::last_error).
    /// rustls-acme retries it, with backoff.
    OrderFailing,
}

/// Why a certificate order failed, or the certificate's cache did, in terms
/// the base can phrase.
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
    /// Any other order failure: an ACME problem the base has no phrasing
    /// for, or a certificate the CA issued that can't be used.
    Other {
        /// The error, for the log and the base's details.
        message: String,
    },
    /// Not an order's failure: the certificate or account cache on this
    /// device couldn't be read or written.
    Cache {
        /// The error, for the log and the base's details.
        message: String,
    },
}

impl CertificateOrderError {
    /// Whether an order failed, rather than the cache.
    fn is_order_failure(&self) -> bool {
        !matches!(self, Self::Cache { .. })
    }
}

/// What the host knows about a server's certificate for its domain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CertificateState {
    /// Where the certificate stands.
    pub status: CertificateStatus,
    /// The CA the certificate is ordered from, as the server's record names
    /// it.
    pub issuer: CertificateAuthority,
    /// The certificate the server holds from `issuer`, valid or expired.
    pub held: Option<IssuedCertificate>,
    /// The run's latest error since it last deployed a certificate: an
    /// order's, or the cache's. Always `None` in the cache's state.
    pub last_error: Option<CertificateOrderError>,
}

impl CertificateState {
    /// What a cache holding `cached` from `issuer` says at `now`, the state
    /// of any server without a run's state: `NotIssued`, `NoRenewalNeeded`,
    /// `RenewalDue` or `Expired`, never `Ordering` or `OrderFailing`.
    #[must_use]
    pub fn of_cached(
        cached: Option<IssuedCertificate>,
        issuer: CertificateAuthority,
        now: DateTime<Utc>,
    ) -> Self {
        let status = match &cached {
            None => CertificateStatus::NotIssued,
            Some(held) => match LifetimePhase::at(held, now) {
                LifetimePhase::NoRenewalNeeded => CertificateStatus::NoRenewalNeeded,
                LifetimePhase::RenewalDue => CertificateStatus::RenewalDue,
                LifetimePhase::Expired => CertificateStatus::Expired,
            },
        };
        Self {
            status,
            issuer,
            held: cached,
            last_error: None,
        }
    }
}

/// How far into its lifetime a certificate is at an instant.
enum LifetimePhase {
    NoRenewalNeeded,
    RenewalDue,
    Expired,
}

impl LifetimePhase {
    fn at(issued: &IssuedCertificate, now: DateTime<Utc>) -> Self {
        if now >= issued.not_after {
            Self::Expired
        } else if now >= issued.renewal_due_at() {
            Self::RenewalDue
        } else {
            Self::NoRenewalNeeded
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
    /// An order failed.
    OrderFailed(CertificateOrderError),
    /// The certificate or account cache couldn't be read or written. Not an
    /// order's failure: rustls-acme keeps ordering.
    CacheFailed {
        /// The error, for the log and the base's details.
        message: String,
    },
}

/// What a run has observed of its certificate: the one it holds and the
/// latest failure since it was deployed. Derives the run's
/// [`CertificateState`] at any instant, and when that state next changes
/// without an event.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct ObservedCertificate {
    held: Option<IssuedCertificate>,
    last_error: Option<CertificateOrderError>,
}

impl ObservedCertificate {
    /// What a run starting with `cached` in its certificate cache has
    /// observed, before rustls-acme has deployed it.
    pub(crate) fn starting_with(cached: Option<IssuedCertificate>) -> Self {
        Self {
            held: cached,
            last_error: None,
        }
    }

    /// What the run has observed after `event`. A deployed certificate clears
    /// the last error.
    #[must_use]
    pub(crate) fn after(self, event: CertificateEvent) -> Self {
        match event {
            CertificateEvent::Deployed(held) => Self {
                held: Some(held),
                last_error: None,
            },
            CertificateEvent::OrderFailed(error) => Self {
                last_error: Some(error),
                ..self
            },
            CertificateEvent::CacheFailed { message } => Self {
                last_error: Some(CertificateOrderError::Cache { message }),
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
        let order_failing = self
            .last_error
            .as_ref()
            .is_some_and(CertificateOrderError::is_order_failure);
        let ordering_or_failing = if order_failing {
            CertificateStatus::OrderFailing
        } else {
            CertificateStatus::Ordering
        };
        let status = match &self.held {
            None => ordering_or_failing,
            Some(held) => match LifetimePhase::at(held, now) {
                LifetimePhase::NoRenewalNeeded => CertificateStatus::NoRenewalNeeded,
                LifetimePhase::RenewalDue => CertificateStatus::RenewalDue,
                LifetimePhase::Expired => ordering_or_failing,
            },
        };
        CertificateState {
            status,
            issuer,
            held: self.held.clone(),
            last_error: self.last_error.clone(),
        }
    }

    /// The next instant after `now` at which the run's state changes with no
    /// event: when its certificate's renewal falls due, then when it expires.
    pub(crate) fn next_status_change(&self, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
        let held = self.held.as_ref()?;
        [held.renewal_due_at(), held.not_after]
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
        let observed = ObservedCertificate::starting_with(None);
        assert_eq!(
            observed.state(ISSUER, on(1, 2)).status,
            CertificateStatus::Ordering
        );

        let observed = observed.after(CertificateEvent::Deployed(ninety_day("a")));
        let state = observed.state(ISSUER, on(1, 2));
        assert_eq!(state.status, CertificateStatus::NoRenewalNeeded);
        assert_eq!(state.held, Some(ninety_day("a")));
        assert_eq!(state.issuer, ISSUER);
    }

    #[test]
    fn a_failed_first_order_is_order_failing_until_a_deploy_clears_it() {
        let observed = ObservedCertificate::starting_with(None)
            .after(CertificateEvent::OrderFailed(rate_limited()));
        let state = observed.state(ISSUER, on(1, 2));
        assert_eq!(state.status, CertificateStatus::OrderFailing);
        assert_eq!(state.last_error, Some(rate_limited()));

        let observed = observed.after(CertificateEvent::Deployed(ninety_day("a")));
        let state = observed.state(ISSUER, on(1, 2));
        assert_eq!(state.status, CertificateStatus::NoRenewalNeeded);
        assert_eq!(state.last_error, None);
    }

    #[test]
    fn a_cache_fault_is_the_last_error_but_the_run_stays_ordering() {
        let cache_fault = || CertificateEvent::CacheFailed {
            message: "account cache store: disk full".to_owned(),
        };
        let observed = ObservedCertificate::starting_with(None).after(cache_fault());
        let state = observed.state(ISSUER, on(1, 2));
        assert_eq!(state.status, CertificateStatus::Ordering);
        assert_eq!(
            state.last_error,
            Some(CertificateOrderError::Cache {
                message: "account cache store: disk full".to_owned()
            })
        );

        let observed = observed.after(CertificateEvent::OrderFailed(rate_limited()));
        assert_eq!(
            observed.state(ISSUER, on(1, 2)).status,
            CertificateStatus::OrderFailing
        );
        let observed = observed.after(cache_fault());
        assert_eq!(
            observed.state(ISSUER, on(1, 2)).status,
            CertificateStatus::Ordering,
            "the latest error is the cache's"
        );
    }

    #[test]
    fn a_run_s_certificate_falls_due_for_renewal_then_is_reordered_once_expired() {
        let observed = ObservedCertificate::starting_with(Some(ninety_day("a")));
        assert_eq!(
            observed.state(ISSUER, on(3, 1)).status,
            CertificateStatus::NoRenewalNeeded
        );
        assert_eq!(
            observed.state(ISSUER, on(3, 2)).status,
            CertificateStatus::RenewalDue
        );
        let expired = on(4, 1);
        assert_eq!(
            observed.state(ISSUER, expired).status,
            CertificateStatus::Ordering
        );
    }

    #[test]
    fn a_failed_renewal_stays_renewal_due_with_its_error_until_the_certificate_expires() {
        let observed = ObservedCertificate::starting_with(Some(ninety_day("a")))
            .after(CertificateEvent::OrderFailed(rate_limited()));
        let state = observed.state(ISSUER, on(3, 2));
        assert_eq!(state.status, CertificateStatus::RenewalDue);
        assert_eq!(state.last_error, Some(rate_limited()));
        let expired = on(4, 1);
        assert_eq!(
            observed.state(ISSUER, expired).status,
            CertificateStatus::OrderFailing
        );
    }

    #[test]
    fn a_renewal_replaces_the_certificate() {
        let renewed = IssuedCertificate {
            not_before: on(3, 2),
            not_after: on(5, 31),
            fingerprint: "b".to_owned(),
        };
        let observed = ObservedCertificate::starting_with(Some(ninety_day("a")))
            .after(CertificateEvent::Deployed(renewed.clone()));
        let state = observed.state(ISSUER, on(3, 2));
        assert_eq!(state.status, CertificateStatus::NoRenewalNeeded);
        assert_eq!(state.held, Some(renewed));
    }

    #[test]
    fn the_state_next_changes_at_renewal_then_at_expiry_then_never() {
        let observed = ObservedCertificate::starting_with(Some(ninety_day("a")));
        assert_eq!(observed.next_status_change(on(1, 2)), Some(on(3, 2)));
        assert_eq!(observed.next_status_change(on(3, 2)), Some(on(4, 1)));
        let expired = on(4, 1);
        assert_eq!(observed.next_status_change(expired), None);
        assert_eq!(
            ObservedCertificate::default().next_status_change(on(1, 2)),
            None
        );
    }

    #[test]
    fn a_cached_lapsed_certificate_is_expired_not_order_failing() {
        let expired = on(6, 1);
        let state = CertificateState::of_cached(Some(ninety_day("a")), ISSUER, expired);
        assert_eq!(state.status, CertificateStatus::Expired);
        assert_eq!(state.last_error, None);
    }

    #[test]
    fn the_cache_reads_not_issued_no_renewal_needed_or_renewal_due() {
        assert_eq!(
            CertificateState::of_cached(None, ISSUER, on(1, 2)).status,
            CertificateStatus::NotIssued
        );
        assert_eq!(
            CertificateState::of_cached(Some(ninety_day("a")), ISSUER, on(1, 2)).status,
            CertificateStatus::NoRenewalNeeded
        );
        assert_eq!(
            CertificateState::of_cached(Some(ninety_day("a")), ISSUER, on(3, 2)).status,
            CertificateStatus::RenewalDue
        );
    }
}
