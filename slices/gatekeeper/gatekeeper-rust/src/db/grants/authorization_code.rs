//! Authorization-code grants in the store: the `authorization_code_grants` table
//! and its single-kind query bodies. A code grant is the standing consent for a
//! `(client_id, redirect_uri)` pair — the identity `/authorize` looks up to decide
//! whether it can skip the consent prompt. Single-kind operations hit this concrete
//! table directly; the cross-kind reads live in [`super::general`].

use chrono::{DateTime, Utc};
use diesel::prelude::*;
use persistence_rust::PooledDieselConnection;
use url::Url;
use uuid::Uuid;

use crate::db::shared::JsonStrings;
use crate::domain::error::GatekeeperError;
use crate::domain::grant::{AuthorizationCodeGrant, CumulativeConsent};

diesel::table! {
    authorization_code_grants (id) {
        id -> Text,
        client_id -> Text,
        scopes -> Text,
        granted_at -> TimestamptzSqlite,
        last_used_at -> Nullable<TimestamptzSqlite>,
        patient -> Nullable<Text>,
        redirect_uri -> Text,
    }
}

/// Find an existing authorization-code grant for the (`client_id`,
/// `redirect_uri`) pair so `/authorize` can decide whether to short-circuit
/// the consent prompt. A single-kind lookup, so it hits the concrete table
/// and returns the concrete struct — a device grant for the same client
/// can never satisfy it.
pub(crate) fn grant_by_client_and_redirect(
    conn: &mut PooledDieselConnection,
    client_id: &str,
    redirect_uri: &Url,
) -> Result<Option<AuthorizationCodeGrant>, GatekeeperError> {
    authorization_code_grants::table
        .filter(authorization_code_grants::client_id.eq(client_id))
        .filter(authorization_code_grants::redirect_uri.eq(redirect_uri.as_str()))
        .select(AuthorizationCodeGrant::as_select())
        .first(conn)
        .optional()
        .map_err(|e| GatekeeperError::infrastructure("grant_by_client_and_redirect failed", e))
}

/// Insert or update the standing **authorization-code** grant for
/// `(client_id, redirect_uri)` in a single transaction on its one table.
/// Consent is cumulative ([`CumulativeConsent`]): an existing grant absorbs
/// the re-approval (scope union, refreshed `granted_at`/`patient`). The
/// read-merge-write under one transaction (paired with the table's
/// `UNIQUE(client_id, redirect_uri)`) means two concurrent approvals can't
/// both insert a duplicate grant.
pub(crate) fn upsert_grant(
    conn: &mut PooledDieselConnection,
    client_id: &str,
    redirect_uri: &Url,
    scopes: &[String],
    patient: Option<&str>,
    now: DateTime<Utc>,
) -> Result<(), GatekeeperError> {
    conn.transaction(|conn| {
        let existing: Option<AuthorizationCodeGrant> = authorization_code_grants::table
            .filter(authorization_code_grants::client_id.eq(client_id))
            .filter(authorization_code_grants::redirect_uri.eq(redirect_uri.as_str()))
            .select(AuthorizationCodeGrant::as_select())
            .first(conn)
            .optional()?;
        match existing {
            Some(mut grant) => {
                grant.absorb_reapproval(scopes, patient, now);
                diesel::update(authorization_code_grants::table.find(&grant.id))
                    .set((
                        authorization_code_grants::scopes.eq(JsonStrings(grant.scopes)),
                        authorization_code_grants::granted_at.eq(grant.granted_at),
                        authorization_code_grants::patient.eq(grant.patient),
                    ))
                    .execute(conn)?;
            }
            None => {
                diesel::insert_into(authorization_code_grants::table)
                    .values(AuthorizationCodeGrant {
                        id: Uuid::new_v4().to_string(),
                        client_id: client_id.to_owned(),
                        scopes: scopes.to_vec(),
                        granted_at: now,
                        last_used_at: None,
                        patient: patient.map(str::to_owned),
                        redirect_uri: redirect_uri.clone(),
                    })
                    .execute(conn)?;
            }
        }
        Ok(())
    })
    .map_err(|e: diesel::result::Error| GatekeeperError::infrastructure("upsert_grant failed", e))
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use url::Url;

    use crate::db::SqliteGatekeeperStore;
    use crate::domain::GatekeeperStore as _;

    fn read(url: &str) -> Url {
        Url::parse(url).expect("valid url")
    }

    /// A code-flow upsert inserts a fresh authorization-code grant, then unions
    /// scopes on re-approval (cumulative consent) rather than replacing them.
    #[test]
    fn upsert_grant_inserts_then_unions_scopes() {
        let store = SqliteGatekeeperStore::open_in_memory().expect("open in-memory store");
        let redirect = read("https://example.com/cb");
        let now = Utc::now();

        store
            .upsert_grant(
                "client-a",
                &redirect,
                &["read".to_owned()],
                Some("pat-1"),
                now,
            )
            .expect("insert");
        let grant = store
            .grant_by_client_and_redirect("client-a", &redirect)
            .expect("query")
            .expect("present");
        assert_eq!(grant.scopes, vec!["read".to_owned()]);
        assert_eq!(grant.patient.as_deref(), Some("pat-1"));

        // Re-approve with an overlapping + a new scope: union, not replace.
        store
            .upsert_grant(
                "client-a",
                &redirect,
                &["read".to_owned(), "write".to_owned()],
                Some("pat-2"),
                Utc::now(),
            )
            .expect("update");
        let updated = store
            .grant_by_client_and_redirect("client-a", &redirect)
            .expect("query")
            .expect("present");
        assert_eq!(
            updated.id, grant.id,
            "the same grant is updated, not duplicated"
        );
        assert_eq!(updated.scopes, vec!["read".to_owned(), "write".to_owned()]);
        assert_eq!(updated.patient.as_deref(), Some("pat-2"));
        assert_eq!(store.all_grants().expect("list").len(), 1);
    }
}
