//! `clients` query bodies — the `pub(super)` free functions the
//! [`SqliteGatekeeperStore`](super::SqliteGatekeeperStore) port impl delegates
//! to for [`Client`] lookup and registration/seeding upserts, each running on a
//! connection the store has already checked out of the pool. They return the
//! port's primitive shapes and raise only
//! [`GatekeeperError::Infrastructure`](crate::domain::error::GatekeeperError::Infrastructure)
//! on a real db failure.

use diesel::prelude::*;
use diesel::sqlite::SqliteConnection;
use url::Url;

use crate::db::shared::{json_text_column, text_enum_column};
use crate::domain::client::{AllowedGrantType, Client, ClientKind};
use crate::domain::error::GatekeeperError;

diesel::table! {
    clients (client_id) {
        client_id -> Text,
        name -> Text,
        kind -> Text,
        redirect_uris -> Text,
        allowed_scopes -> Text,
        allowed_grant_types -> Text,
        secret_hash -> Nullable<Text>,
        registered_at -> TimestamptzSqlite,
        disabled_at -> Nullable<TimestamptzSqlite>,
    }
}

json_text_column!(
    /// A client's `redirect_uris` allowlist as a JSON TEXT column.
    JsonUrls,
    Vec<Url>
);
json_text_column!(
    /// A client's `allowed_grant_types` as a JSON TEXT column (the wire
    /// `grant_type` strings, per [`AllowedGrantType`]'s serde renames).
    JsonAllowedGrantTypes,
    Vec<AllowedGrantType>
);

// The client `kind` discriminant, stored as its strum wire string. Only the
// client binds it, so its mapping lives here rather than in `db::shared`.
text_enum_column!(ClientKind);

/// Look up a registered client by its `client_id`, or `None` when absent.
pub(super) fn client_by_id(
    conn: &mut SqliteConnection,
    client_id: &str,
) -> Result<Option<Client>, GatekeeperError> {
    clients::table
        .find(client_id)
        .select(Client::as_select())
        .first(conn)
        .optional()
        .map_err(|e| GatekeeperError::infrastructure("client_by_id failed", e))
}

/// Persist a new OAuth client.
pub(super) fn register_client(
    conn: &mut SqliteConnection,
    client: &Client,
) -> Result<(), GatekeeperError> {
    diesel::insert_into(clients::table)
        // `Client`'s JSON list fields use `#[diesel(serialize_as)]`, which
        // consumes the value — diesel generates no borrowed `Insertable`
        // impl for the struct, so the insert takes a clone.
        .values(client.clone())
        .execute(conn)
        .map_err(|e| GatekeeperError::infrastructure("register_client failed", e))?;
    Ok(())
}

/// Insert a client, or update its policy fields if one with the same
/// `client_id` already exists. Used by first-boot seeding so a seeded
/// client's definition always matches the code, even on a store created by
/// an older build. Uses `ON CONFLICT … DO UPDATE`, so it never deletes the
/// row and preserves `registered_at` and `disabled_at` — an upgrade keeps
/// the original registration time and any admin disable rather than
/// resurrecting the client.
pub(super) fn upsert_client(
    conn: &mut SqliteConnection,
    client: &Client,
) -> Result<(), GatekeeperError> {
    use diesel::upsert::excluded;
    diesel::insert_into(clients::table)
        .values(client.clone())
        .on_conflict(clients::client_id)
        .do_update()
        .set((
            clients::name.eq(excluded(clients::name)),
            clients::kind.eq(excluded(clients::kind)),
            clients::redirect_uris.eq(excluded(clients::redirect_uris)),
            clients::allowed_scopes.eq(excluded(clients::allowed_scopes)),
            clients::allowed_grant_types.eq(excluded(clients::allowed_grant_types)),
            clients::secret_hash.eq(excluded(clients::secret_hash)),
        ))
        .execute(conn)
        .map_err(|e| GatekeeperError::infrastructure("upsert_client failed", e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::{arb_opt_timestamp, arb_timestamp, arb_url};
    use crate::db::SqliteGatekeeperStore;
    use crate::domain::client::{AllowedGrantType, ClientKind};
    use crate::domain::GatekeeperStore as _;
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
                    redirect_uris,
                    allowed_scopes,
                    allowed_grant_types: AllowedGrantType::ALL.to_vec(),
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
            let store = SqliteGatekeeperStore::open_in_memory().expect("open in-memory store");
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
        let store = SqliteGatekeeperStore::open_in_memory().expect("open in-memory store");
        let registered_at = chrono::DateTime::from_timestamp(1_000, 0).unwrap();
        let disabled_at = chrono::DateTime::from_timestamp(1_500, 0).unwrap();
        let mut client = Client {
            client_id: "c1".to_string(),
            name: "First".to_string(),
            kind: ClientKind::Public,
            redirect_uris: vec![],
            allowed_scopes: vec!["openid".to_string()],
            allowed_grant_types: AllowedGrantType::ALL.to_vec(),
            secret_hash: None,
            registered_at,
            disabled_at: Some(disabled_at),
        };
        store.upsert_client(&client).expect("insert");

        // Re-seed with drifted policy, a newer registered_at, and disabled_at
        // cleared: the policy fields update, but registration time and the admin
        // disable are preserved (the row is updated in place, never resurrected).
        client.name = "Renamed".to_string();
        client.allowed_scopes = vec!["system/*.cruds".to_string()];
        client.registered_at = chrono::DateTime::from_timestamp(2_000, 0).unwrap();
        client.disabled_at = None;
        store.upsert_client(&client).expect("update");

        let fetched = store
            .client_by_id("c1")
            .expect("query")
            .expect("row present");
        assert_eq!(fetched.name, "Renamed");
        assert_eq!(fetched.allowed_scopes, vec!["system/*.cruds".to_string()]);
        assert_eq!(fetched.registered_at, registered_at);
        assert_eq!(fetched.disabled_at, Some(disabled_at));
    }

    /// The SMART sample-app clients are seeded by migration `0003` (not Rust),
    /// so a freshly-migrated store has them — and every hand-written row
    /// decodes back to a valid `Client`. This is the guard that the SQL seed's
    /// JSON columns and `registered_at` text stay in the exact shape the
    /// store's read path parses (a malformed value would fail `client_by_id`'s
    /// row mapping, not silently).
    #[test]
    fn migration_seeds_the_sample_smart_clients() {
        let store = SqliteGatekeeperStore::open_in_memory().expect("open in-memory store");
        for client_id in [
            "growth_chart",
            "my_web_app",
            "cc344727-6f90-496c-94fd-c7829aa9a51d",
        ] {
            let client = store
                .client_by_id(client_id)
                .expect("query (a decode failure surfaces here)")
                .unwrap_or_else(|| panic!("{client_id} is seeded by migration 0003"));
            assert_eq!(client.client_id, client_id);
            assert_eq!(client.kind, ClientKind::Public);
            assert!(
                client.secret_hash.is_none(),
                "{client_id} is a public client"
            );
            assert!(!client.allowed_scopes.is_empty());
            assert!(!client.redirect_uris.is_empty());
            assert!(!client.allowed_grant_types.is_empty());
        }

        // `my_web_app` (the Medication Viewer registration) carries the exact
        // scope + redirect from the review comment.
        let mwa = store.client_by_id("my_web_app").unwrap().unwrap();
        assert_eq!(
            mwa.allowed_scopes,
            vec![
                "launch".to_string(),
                "openid".to_string(),
                "fhirUser".to_string(),
                "patient/*.read".to_string(),
            ],
        );
        assert_eq!(
            mwa.redirect_uris[0].as_str(),
            "https://mitre.github.io/smart-on-fhir-demo/index.html",
        );
        assert_eq!(
            mwa.allowed_grant_types,
            vec![
                AllowedGrantType::AuthorizationCode,
                AllowedGrantType::RefreshToken
            ],
        );

        // The old `medication_viewer` id is gone — replaced by `my_web_app`.
        assert!(store.client_by_id("medication_viewer").unwrap().is_none());
    }

    /// Each of the client row's custom column mappings rejects an out-of-domain
    /// stored value on read as a typed diesel error, never a panic: the JSON TEXT
    /// newtypes ([`JsonUrls`](super::JsonUrls) / [`JsonStrings`](crate::db::shared::JsonStrings)
    /// / [`JsonAllowedGrantTypes`](super::JsonAllowedGrantTypes)) on malformed JSON
    /// or an unknown enum member, and the [`ClientKind`] text-enum mapping on an
    /// unknown discriminant. A row tampered via raw SQL surfaces at the
    /// `client_by_id` read boundary as `Err`, so a corrupt row can never silently
    /// decode to a wrong-but-valid client.
    #[test]
    fn stored_columns_reject_corrupt_values() {
        // `column = bad_value` tampered onto the migration-seeded `growth_chart`
        // row, each asserted to fail the read.
        for (column, bad_value) in [
            ("redirect_uris", "not json"),        // JsonUrls: malformed JSON
            ("redirect_uris", "[\"not a url\"]"), // JsonUrls: valid JSON, invalid URL
            ("allowed_scopes", "not json"),       // JsonStrings: malformed JSON
            ("allowed_grant_types", "[\"totally_unknown\"]"), // JsonAllowedGrantTypes: unknown member
            ("kind", "bogus_kind"),                           // ClientKind: unknown discriminant
        ] {
            let store = SqliteGatekeeperStore::open_in_memory().expect("open in-memory store");
            let mut conn = store.pool().get().expect("check out a connection");
            diesel::sql_query(format!(
                "UPDATE clients SET {column} = '{bad_value}' WHERE client_id = 'growth_chart'"
            ))
            .execute(&mut conn)
            .expect("tamper the stored row");
            drop(conn);
            assert!(
                store.client_by_id("growth_chart").is_err(),
                "a corrupt `{column}` must surface as a typed read error",
            );
        }
    }
}
