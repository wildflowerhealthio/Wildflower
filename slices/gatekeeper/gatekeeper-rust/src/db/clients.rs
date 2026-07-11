use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ToSqlOutput, ValueRef};
use rusqlite::{params, OptionalExtension, ToSql};

use crate::db::GatekeeperStore;
use crate::domain::client::{Client, ClientKind};
use crate::domain::error::GatekeeperError;
use persistence_rust::build_insert_sql;
use persistence_rust::sql_row;

impl ToSql for ClientKind {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        let wire: &str = self.as_ref();
        Ok(ToSqlOutput::Borrowed(ValueRef::Text(wire.as_bytes())))
    }
}

impl FromSql for ClientKind {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        let s = value.as_str()?;
        s.parse::<ClientKind>()
            .map_err(|e| FromSqlError::Other(Box::new(e)))
    }
}

sql_row!(Client {
    client_id,
    name,
    kind,
    redirect_uris,
    allowed_scopes,
    allowed_grant_types,
    secret_hash,
    registered_at,
    disabled_at,
});

impl GatekeeperStore {
    /// Look up a registered client by its `client_id`.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Backend`] if the select query fails or a returned
    /// row cannot be mapped to a [`Client`].
    pub fn client_by_id(&self, client_id: &str) -> Result<Option<Client>, GatekeeperError> {
        self.conn()
            .lock()
            .query_row(
                &format!("SELECT {ALL_COLS} FROM clients WHERE client_id = ?1"),
                params![client_id],
                |row| Client::try_from(row),
            )
            .optional()
            .map_err(|e| GatekeeperError::backend("client_by_id failed", e))
    }

    /// Persist a new OAuth client.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Backend`] if the insert fails (for example a
    /// unique-constraint violation on the `client_id`).
    pub fn register_client(&self, client: &Client) -> Result<(), GatekeeperError> {
        let params = make_named_sql_params(client);
        self.conn()
            .lock()
            .execute(&build_insert_sql("clients", &params), &params)
            .map_err(|e| GatekeeperError::backend("register_client failed", e))?;
        Ok(())
    }

    /// Insert a client, or update its policy fields if one with the same
    /// `client_id` already exists. Used by first-boot seeding so a seeded
    /// client's definition always matches the code, even on a store created by an
    /// older build. Uses `ON CONFLICT … DO UPDATE`, so it never deletes the row
    /// (no FK cascade) and preserves `registered_at` and `disabled_at` — an
    /// upgrade keeps the original registration time and any admin disable rather
    /// than resurrecting the client.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Backend`] if the upsert fails.
    pub fn upsert_client(&self, client: &Client) -> Result<(), GatekeeperError> {
        let params = make_named_sql_params(client);
        let sql = format!(
            "{} ON CONFLICT(client_id) DO UPDATE SET \
             name = excluded.name, \
             kind = excluded.kind, \
             redirect_uris = excluded.redirect_uris, \
             allowed_scopes = excluded.allowed_scopes, \
             allowed_grant_types = excluded.allowed_grant_types, \
             secret_hash = excluded.secret_hash",
            build_insert_sql("clients", &params)
        );
        self.conn()
            .lock()
            .execute(&sql, &params)
            .map_err(|e| GatekeeperError::backend("upsert_client failed", e))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::{arb_opt_timestamp, arb_timestamp, arb_url};
    use crate::domain::client::{AllowedGrantType, ClientKind};
    use persistence_rust::JsonColumn;
    use proptest::prelude::*;

    fn arb_client() -> impl Strategy<Value = Client> {
        (
            "[a-zA-Z0-9_-]{1,32}",
            "[ -~]{0,48}",
            prop_oneof![Just(ClientKind::Public), Just(ClientKind::Confidential)],
            prop::collection::vec(arb_url(), 1..4),
            prop::collection::vec("[a-z][a-z0-9_]{0,15}", 0..5),
            prop::option::of("[0-9a-f]{64}"),
            arb_timestamp(),
            arb_opt_timestamp(),
        )
            .prop_map(
                |(
                    client_id,
                    name,
                    kind,
                    redirect_uris,
                    allowed_scopes,
                    secret_hash,
                    registered_at,
                    disabled_at,
                )| Client {
                    client_id,
                    name,
                    kind,
                    redirect_uris: JsonColumn(redirect_uris),
                    allowed_scopes: JsonColumn(allowed_scopes),
                    allowed_grant_types: JsonColumn(AllowedGrantType::ALL.to_vec()),
                    secret_hash,
                    registered_at,
                    disabled_at,
                },
            )
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(48))]

        #[test]
        fn register_and_fetch_round_trip(client in arb_client()) {
            let store = GatekeeperStore::open_in_memory().expect("open in-memory store");
            store.register_client(&client).expect("register");
            let fetched = store
                .client_by_id(&client.client_id)
                .expect("query")
                .expect("row present");
            prop_assert_eq!(fetched, client);
        }
    }

    #[test]
    fn upsert_updates_policy_but_preserves_registration_and_disable() {
        let store = GatekeeperStore::open_in_memory().expect("open in-memory store");
        let registered_at = chrono::DateTime::from_timestamp(1_000, 0).unwrap();
        let disabled_at = chrono::DateTime::from_timestamp(1_500, 0).unwrap();
        let mut client = Client {
            client_id: "c1".to_string(),
            name: "First".to_string(),
            kind: ClientKind::Public,
            redirect_uris: JsonColumn(vec![]),
            allowed_scopes: JsonColumn(vec!["openid".to_string()]),
            allowed_grant_types: JsonColumn(AllowedGrantType::ALL.to_vec()),
            secret_hash: None,
            registered_at,
            disabled_at: Some(disabled_at),
        };
        store.upsert_client(&client).expect("insert");

        // Re-seed with drifted policy, a newer registered_at, and disabled_at
        // cleared: the policy fields update, but registration time and the admin
        // disable are preserved (the row is updated in place, never resurrected).
        client.name = "Renamed".to_string();
        client.allowed_scopes = JsonColumn(vec!["system/*.cruds".to_string()]);
        client.registered_at = chrono::DateTime::from_timestamp(2_000, 0).unwrap();
        client.disabled_at = None;
        store.upsert_client(&client).expect("update");

        let fetched = store
            .client_by_id("c1")
            .expect("query")
            .expect("row present");
        assert_eq!(fetched.name, "Renamed");
        assert_eq!(fetched.allowed_scopes.0, vec!["system/*.cruds".to_string()]);
        assert_eq!(fetched.registered_at, registered_at);
        assert_eq!(fetched.disabled_at, Some(disabled_at));
    }

    /// The SMART sample-app clients are seeded by migration `008` (not Rust), so a
    /// freshly-migrated store has them — and every hand-written row decodes back to
    /// a valid `Client`. This is the guard that the SQL seed's JSON columns and
    /// `registered_at` text stay in the exact shape the store's read path parses
    /// (a malformed value would fail `client_by_id`'s row mapping, not silently).
    #[test]
    fn migration_seeds_the_sample_smart_clients() {
        let store = GatekeeperStore::open_in_memory().expect("open in-memory store");
        for client_id in [
            "growth_chart",
            "my_web_app",
            "cc344727-6f90-496c-94fd-c7829aa9a51d",
        ] {
            let client = store
                .client_by_id(client_id)
                .expect("query (a decode failure surfaces here)")
                .unwrap_or_else(|| panic!("{client_id} is seeded by migration 008"));
            assert_eq!(client.client_id, client_id);
            assert_eq!(client.kind, ClientKind::Public);
            assert!(
                client.secret_hash.is_none(),
                "{client_id} is a public client"
            );
            assert!(!client.allowed_scopes.0.is_empty());
            assert!(!client.redirect_uris.0.is_empty());
            assert!(!client.allowed_grant_types.0.is_empty());
        }

        // `my_web_app` (the Medication Viewer registration) carries the exact
        // scope + redirect from the review comment.
        let mwa = store.client_by_id("my_web_app").unwrap().unwrap();
        assert_eq!(
            mwa.allowed_scopes.0,
            vec![
                "launch".to_string(),
                "openid".to_string(),
                "fhirUser".to_string(),
                "patient/*.read".to_string(),
            ],
        );
        assert_eq!(
            mwa.redirect_uris.0[0].as_str(),
            "https://mitre.github.io/smart-on-fhir-demo/index.html",
        );
        assert_eq!(
            mwa.allowed_grant_types.0,
            vec![
                AllowedGrantType::AuthorizationCode,
                AllowedGrantType::RefreshToken
            ],
        );

        // The old `medication_viewer` id is gone — replaced by `my_web_app`.
        assert!(store.client_by_id("medication_viewer").unwrap().is_none());
    }
}
