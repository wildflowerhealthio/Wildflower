//! Retention policy for the gatekeeper's accumulating tables — the windows
//! themselves plus [`purge_expired`], the sweep that applies them.
//!
//! Three tables grow and nothing shrinks them. Refresh-token lineage is
//! *expired in place*, never deleted (revocation pulls `expires_at` back so a
//! replayed token still resolves to its dead family — see
//! [`GatekeeperTx::expire_refresh_token_family`]), and rotation appends a row
//! per generation. Authorization requests have no transition out of `pending`
//! for a flow the user simply abandoned. Authorization codes are deleted on
//! redemption, but a code nobody comes back for stays.
//!
//! In every case the audit value is bounded — a lineage is interesting while
//! someone might still ask what happened to it, not forever — so the fix is a
//! window, not a `DELETE … WHERE expires_at < now`. Each window is measured
//! **past the row's own `expires_at`**, i.e. past the point the row stopped
//! being usable, so nothing live is ever in range.
//!
//! The sweep runs on a timer from `setup_gatekeeper` (startup, then daily), so
//! the desktop app needs no external cron.

use chrono::{DateTime, Duration, Utc};

use crate::domain::gatekeeper_error::GatekeeperError;
use crate::domain::{GatekeeperStore, GatekeeperTx};

/// How long a refresh-token family (and its tokens) is kept **past its absolute
/// deadline**. Matches
/// [`REFRESH_TOKEN_FAMILY_TTL`](crate::domain::refresh_token::REFRESH_TOKEN_FAMILY_TTL),
/// so a family that runs its full course is readable for roughly twice its own
/// lifetime before being reclaimed — the whole lineage stays auditable for a
/// quarter after it dies, including the revoked-for-reuse case, where
/// `expires_at` was pulled back to the revocation instant and the clock
/// therefore starts at the revocation rather than at the original deadline.
pub const REFRESH_TOKEN_FAMILY_RETENTION: Duration = Duration::days(90);

/// How long an expired authorization request or authorization code is kept.
/// Both are minute-scale objects (a 5-minute request TTL), so a week is a
/// generous audit buffer over a very short useful life — long enough to answer
/// "what did that client try to do last Tuesday", short enough that abandoned
/// flows can't accumulate.
pub const AUTHORIZATION_RETENTION: Duration = Duration::days(7);

/// What one [`purge_expired`] pass reclaimed, per table. All-zero is the
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
/// transaction, and report what went.
///
/// `now` is a parameter rather than a `Utc::now()` inside, so tests can place
/// rows either side of a window without sleeping and the whole pass reads one
/// consistent instant.
///
/// Each delete is guarded by its own window, computed here and handed down as a
/// cutoff — the primitives never see a policy constant. Nothing live can match:
/// a live refresh-token family has `expires_at` in the *future*, so it is not
/// merely outside the 90-day window but on the far side of `now`; the same holds
/// for a pending request or an unredeemed code against the 7-day window.
///
/// Idempotent by construction — a second pass at the same `now` matches nothing
/// and reports all-zero.
///
/// # Errors
///
/// [`GatekeeperError::Infrastructure`] if the transaction or any of the three
/// deletes fails. The transaction means a partial sweep is rolled back, so a
/// failure leaves the retained set exactly as it was.
pub(crate) fn purge_expired(
    store: &impl GatekeeperStore,
    now: DateTime<Utc>,
) -> Result<PurgedCounts, GatekeeperError> {
    let family_cutoff = now - REFRESH_TOKEN_FAMILY_RETENTION;
    let authorization_cutoff = now - AUTHORIZATION_RETENTION;
    store.transaction(|tx| {
        // Struct-literal fields evaluate in source order, so the family delete
        // (which drops child tokens first) runs before the two flat ones. The
        // order doesn't matter across tables — the three sets are disjoint — but
        // stating it keeps the FK-ordered step at the front where it reads.
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
