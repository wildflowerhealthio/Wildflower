//! Retention policy for the gatekeeper's three accumulating tables — the
//! windows themselves plus `purge_expired`, the sweep that applies them.
//!
//! Each window is measured **past the row's own `expires_at`**, so nothing live
//! is ever in range. Which tables grow, why each window is what it is, and why
//! the sweep runs on a timer rather than on the insert path:
//! `slices/gatekeeper/docs/Retention Explanation.md`.

use chrono::{DateTime, Duration, Utc};

use crate::domain::gatekeeper_error::GatekeeperError;
use crate::domain::{GatekeeperStore, GatekeeperTx};

/// How long a refresh-token family (and its tokens) is kept past its absolute
/// deadline. Deliberately equal to
/// [`REFRESH_TOKEN_FAMILY_TTL`](crate::domain::refresh_token::REFRESH_TOKEN_FAMILY_TTL) —
/// a lineage stays auditable for its own lifetime again after it dies.
pub const REFRESH_TOKEN_FAMILY_RETENTION: Duration = Duration::days(90);

/// How long an expired authorization request or code is kept — a generous audit
/// buffer over objects whose useful life is minutes.
pub const AUTHORIZATION_RETENTION: Duration = Duration::days(7);

/// What one `purge_expired` pass reclaimed, per table. All-zero is the
/// steady state, and the caller logs only a non-[`is_empty`](Self::is_empty)
/// result so an idle app produces no log noise.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PurgedCounts {
    /// Refresh-token **families** deleted. Their tokens went with them; the
    /// token rows are not counted separately.
    pub refresh_token_families: usize,
    /// Authorization requests deleted.
    pub authorization_requests: usize,
    /// Authorization codes deleted.
    pub authorization_codes: usize,
}

impl PurgedCounts {
    /// Whether the pass reclaimed nothing at all.
    #[must_use]
    pub fn is_empty(self) -> bool {
        self.refresh_token_families == 0
            && self.authorization_requests == 0
            && self.authorization_codes == 0
    }
}

/// Delete every row that has aged past its retention window as of `now`, in one
/// transaction, and report what went. Idempotent — a second pass at the same
/// `now` matches nothing.
///
/// `now` is a parameter rather than a `Utc::now()` inside, so the whole pass
/// reads one instant and tests can place rows either side of a window without
/// sleeping. Each window is turned into a cutoff here; the store primitives
/// never see a policy constant.
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if the transaction or any of the three
/// deletes fails — rolled back, so a failure leaves the retained set as it was.
pub(crate) fn purge_expired(
    store: &impl GatekeeperStore,
    now: DateTime<Utc>,
) -> Result<PurgedCounts, GatekeeperError> {
    let family_cutoff = now - REFRESH_TOKEN_FAMILY_RETENTION;
    let authorization_cutoff = now - AUTHORIZATION_RETENTION;
    store.transaction(|tx| {
        Ok(PurgedCounts {
            refresh_token_families: tx
                .delete_refresh_token_families_expired_before(family_cutoff)?,
            authorization_requests: tx
                .delete_authorization_requests_expired_before(authorization_cutoff)?,
            authorization_codes: tx
                .delete_authorization_codes_expired_before(authorization_cutoff)?,
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::authorization_code::AuthorizationCode;
    use crate::domain::authorization_request::{AuthorizationRequest, GrantType, RequestStatus};
    use crate::domain::refresh_token::{RefreshToken, RefreshTokenFamily};
    use crate::domain::test_fake::FakeGatekeeperStore;

    /// A fixed "now" so every fixture below can be placed relative to it
    /// without a clock read — the windows are the thing under test, not the
    /// wall clock.
    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-07-01T12:00:00Z")
            .expect("fixed instant")
            .with_timezone(&Utc)
    }

    fn family(family_id: &str, expires_at: DateTime<Utc>) -> RefreshTokenFamily {
        RefreshTokenFamily {
            family_id: family_id.to_string(),
            client_id: "client-1".to_string(),
            scopes: vec!["read".to_string()],
            patient: None,
            issued_at: expires_at - Duration::days(90),
            expires_at,
            authorization_code_hash: None,
            grant_id: None,
        }
    }

    fn token(token_hash: &str, family_id: &str) -> RefreshToken {
        RefreshToken {
            token_hash: token_hash.to_string(),
            family_id: family_id.to_string(),
            issued_at: now() - Duration::days(200),
            consumed_at: None,
        }
    }

    fn request(id: &str, expires_at: DateTime<Utc>) -> AuthorizationRequest {
        AuthorizationRequest {
            id: id.to_string(),
            grant_type: GrantType::DeviceCode,
            client_id: "client-1".to_string(),
            requested_scopes: vec!["openid".to_string()],
            code_challenge: None,
            code_challenge_method: None,
            redirect_uri: None,
            client_state: None,
            user_code: Some(format!("UC-{id}")),
            pre_approved_scopes: vec![],
            requested_at: expires_at - Duration::minutes(5),
            expires_at,
            last_polled_at: None,
            status: RequestStatus::Pending,
            granted_scopes: None,
            patient: None,
            device_name: None,
        }
    }

    fn code(code: &str, expires_at: DateTime<Utc>) -> AuthorizationCode {
        AuthorizationCode {
            code: code.to_string(),
            request_id: format!("req-{code}"),
            client_id: "client-1".to_string(),
            redirect_uri: url::Url::parse("https://example.com/cb").expect("url"),
            code_challenge: "c".repeat(43),
            granted_scopes: vec!["read".to_string()],
            patient: None,
            issued_at: expires_at - Duration::minutes(1),
            expires_at,
        }
    }

    /// Seed one row of each kind on each side of its window, plus a genuinely
    /// live refresh-token family, and return the store.
    fn seeded() -> FakeGatekeeperStore {
        let store = FakeGatekeeperStore::default();
        // Past the 90-day window (its deadline is 91 days behind `now`).
        store
            .insert_refresh_token_family_row(&family("old", now() - Duration::days(91)))
            .expect("seed old family");
        store
            .insert_refresh_token(&token("old-token", "old"))
            .expect("seed old token");
        // Dead, but only 89 days dead — still inside the window.
        store
            .insert_refresh_token_family_row(&family("recent", now() - Duration::days(89)))
            .expect("seed recent family");
        store
            .insert_refresh_token(&token("recent-token", "recent"))
            .expect("seed recent token");
        // Live: deadline still ahead of `now`.
        store
            .insert_refresh_token_family_row(&family("live", now() + Duration::days(30)))
            .expect("seed live family");
        store
            .insert_refresh_token(&token("live-token", "live"))
            .expect("seed live token");

        store
            .insert_authorization_request(&request("old", now() - Duration::days(8)))
            .expect("seed old request");
        store
            .insert_authorization_request(&request("recent", now() - Duration::days(6)))
            .expect("seed recent request");
        store
            .insert_authorization_request(&request("live", now() + Duration::minutes(5)))
            .expect("seed live request");

        store
            .issue_authorization_code(&code("old", now() - Duration::days(8)))
            .expect("seed old code");
        store
            .issue_authorization_code(&code("recent", now() - Duration::days(6)))
            .expect("seed recent code");
        store
            .issue_authorization_code(&code("live", now() + Duration::minutes(1)))
            .expect("seed live code");
        store
    }

    /// The whole policy in one assertion: a row one day past its window goes, a
    /// row one day short of it stays, and a live row is never in range. Both
    /// windows are exercised at once because they share the transaction.
    #[test]
    fn purges_past_each_window_and_spares_everything_inside_it() {
        let store = seeded();

        let purged = purge_expired(&store, now()).expect("sweep");

        assert_eq!(
            purged,
            PurgedCounts {
                refresh_token_families: 1,
                authorization_requests: 1,
                authorization_codes: 1,
            },
        );
        assert!(store
            .refresh_token_with_family_by_hash("old-token")
            .expect("query")
            .is_none());
        assert!(store
            .refresh_token_with_family_by_hash("recent-token")
            .expect("query")
            .is_some());
        assert!(store
            .refresh_token_with_family_by_hash("live-token")
            .expect("query")
            .is_some());
        assert!(store
            .authorization_request_by_id("old")
            .expect("query")
            .is_none());
        assert!(store
            .authorization_request_by_id("recent")
            .expect("query")
            .is_some());
        assert!(store
            .authorization_request_by_id("live")
            .expect("query")
            .is_some());
        assert!(store
            .authorization_code_by_request_id("req-old")
            .expect("query")
            .is_none());
        assert!(store
            .authorization_code_by_request_id("req-recent")
            .expect("query")
            .is_some());
        assert!(store
            .authorization_code_by_request_id("req-live")
            .expect("query")
            .is_some());
    }

    /// Deleting a family takes its tokens with it — the child rows must not
    /// survive as orphans pointing at a family_id nobody can resolve.
    #[test]
    fn deleting_a_family_takes_its_tokens() {
        let store = seeded();
        store
            .insert_refresh_token(&token("old-token-2", "old"))
            .expect("seed a second generation");

        purge_expired(&store, now()).expect("sweep");

        for orphan in ["old-token", "old-token-2"] {
            assert!(
                store
                    .refresh_token_with_family_by_hash(orphan)
                    .expect("query")
                    .is_none(),
                "{orphan} outlived its family",
            );
        }
    }

    /// The sweep is idempotent: a second pass at the same instant finds nothing
    /// left in range, so the daily timer re-running over a quiet database is a
    /// no-op rather than a slow re-delete.
    #[test]
    fn a_second_pass_reclaims_nothing() {
        let store = seeded();
        assert!(!purge_expired(&store, now())
            .expect("first sweep")
            .is_empty());

        let second = purge_expired(&store, now()).expect("second sweep");

        assert_eq!(second, PurgedCounts::default());
        assert!(second.is_empty());
    }

    /// An empty database sweeps cleanly — the startup tick on a first-ever boot
    /// runs against exactly this.
    #[test]
    fn an_empty_database_reclaims_nothing() {
        let store = FakeGatekeeperStore::default();
        assert_eq!(
            purge_expired(&store, now()).expect("sweep"),
            PurgedCounts::default(),
        );
    }

    /// The window really is measured from `expires_at`, not from `now` alone:
    /// the same store swept 90 days later reclaims the rows that were spared
    /// the first time. Guards against a cutoff accidentally written as `now`.
    #[test]
    fn the_spared_rows_are_reclaimed_once_they_age_out() {
        let store = seeded();
        purge_expired(&store, now()).expect("first sweep");

        let later = purge_expired(&store, now() + Duration::days(90)).expect("later sweep");

        assert_eq!(later.refresh_token_families, 1, "the 89-day-dead family");
        assert_eq!(
            later.authorization_requests, 2,
            "the 6-day-old + the live one"
        );
        assert_eq!(later.authorization_codes, 2);
        assert!(store
            .refresh_token_with_family_by_hash("recent-token")
            .expect("query")
            .is_none());
    }
}
