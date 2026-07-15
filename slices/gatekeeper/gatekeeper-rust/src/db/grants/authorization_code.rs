//! Authorization-code grants in the store: the `authorization_code_grants` table
//! and its single-kind query bodies. A code grant is the standing consent for a
//! `(client_id, redirect_uri)` pair — the identity `/authorize` looks up to decide
//! whether it can skip the consent prompt. Single-kind operations hit this concrete
//! table directly; the cross-kind reads live in [`super::general`].

use diesel::prelude::*;
use diesel::sqlite::SqliteConnection;
use url::Url;

use crate::db::shared::JsonStrings;
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::domain::grant::AuthorizationCodeGrant;

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

/// Insert a brand-new authorization-code grant row — a plain single-table
/// insert. The insert branch of a first-time approval, and a test/seed helper;
/// the scope-union re-approval flow is
/// [`upsert_authorization_code_grant`](crate::domain::actions::upsert_authorization_code_grant),
/// which reads then chooses this or [`update_authorization_code_grant`]. The
/// caller hands the concrete grant, so the store never inspects a polymorphic
/// value to choose the table.
pub(crate) fn create_authorization_code_grant(
    conn: &mut SqliteConnection,
    grant: &AuthorizationCodeGrant,
) -> Result<(), GatekeeperError> {
    diesel::insert_into(authorization_code_grants::table)
        .values(grant.clone())
        .execute(conn)
        .map_err(|e| {
            GatekeeperError::infrastructure("create_authorization_code_grant failed", e)
        })?;
    Ok(())
}

/// Find an existing authorization-code grant for the (`client_id`,
/// `redirect_uri`) pair so `/authorize` can decide whether to short-circuit
/// the consent prompt. A single-kind lookup, so it hits the concrete table
/// and returns the concrete struct — a device grant for the same client
/// can never satisfy it.
pub(crate) fn grant_by_client_and_redirect(
    conn: &mut SqliteConnection,
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

/// Overwrite the mutable fields (`scopes`, `granted_at`, `patient`) of the
/// authorization-code grant identified by `grant.id` — the write half of a
/// re-approval, after
/// [`upsert_authorization_code_grant`](crate::domain::actions::upsert_authorization_code_grant)
/// has read the standing grant and folded the re-approval into it via
/// [`absorb_reapproval`](crate::domain::grant::CumulativeConsent). The action
/// runs the read + this write inside one `BEGIN IMMEDIATE` transaction so two
/// concurrent approvals serialise at the read rather than both reading the
/// pre-merge row and one losing its scope union; this body is just the `UPDATE`.
pub(crate) fn update_authorization_code_grant(
    conn: &mut SqliteConnection,
    grant: &AuthorizationCodeGrant,
) -> Result<(), GatekeeperError> {
    diesel::update(authorization_code_grants::table.find(&grant.id))
        .set((
            authorization_code_grants::scopes.eq(JsonStrings(grant.scopes.clone())),
            authorization_code_grants::granted_at.eq(grant.granted_at),
            authorization_code_grants::patient.eq(grant.patient.clone()),
        ))
        .execute(conn)
        .map_err(|e| {
            GatekeeperError::infrastructure("update_authorization_code_grant failed", e)
        })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use url::Url;

    use crate::db::SqliteGatekeeperStore;
    use crate::domain::actions;
    use crate::domain::GatekeeperStore as _;

    fn read(url: &str) -> Url {
        Url::parse(url).expect("valid url")
    }

    /// The `upsert_authorization_code_grant` action, driven end-to-end against
    /// the real `SQLite` adapter: a first approval inserts (via
    /// `create_authorization_code_grant`), a re-approval reads the standing
    /// grant, unions scopes (cumulative consent) and writes it back through
    /// `update_authorization_code_grant` — all inside the action's
    /// `BEGIN IMMEDIATE` transaction, against one row. The pure union decision
    /// is unit-tested against the fake in `domain::actions::grant`; this proves
    /// the same script lands correctly through diesel.
    #[test]
    fn upsert_action_inserts_then_unions_scopes_over_sqlite() {
        let store = SqliteGatekeeperStore::open_in_memory().expect("open in-memory store");
        let redirect = read("https://example.com/cb");
        let now = Utc::now();

        actions::upsert_authorization_code_grant(
            &store,
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
        actions::upsert_authorization_code_grant(
            &store,
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
