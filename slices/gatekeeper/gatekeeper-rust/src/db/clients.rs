use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ToSqlOutput, ValueRef};
use rusqlite::{params, OptionalExtension, Row, ToSql};

use crate::db_utils::sql_builder::build_insert_sql;
use crate::db_utils::{DbResult, GatekeeperStore};
use crate::domain::client::{Client, ClientKind};

const ALL_COLS: &str =
    "client_id, name, kind, redirect_uris, allowed_scopes, allowed_grant_types, \
     secret_hash, registered_at, disabled_at";

impl ToSql for ClientKind {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(ToSqlOutput::Borrowed(ValueRef::Text(
            <&str>::from(self).as_bytes(),
        )))
    }
}

impl FromSql for ClientKind {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        let s = value.as_str()?;
        s.parse::<ClientKind>()
            .map_err(|e| FromSqlError::Other(Box::new(e)))
    }
}

impl TryFrom<&Row<'_>> for Client {
    type Error = rusqlite::Error;
    fn try_from(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Client {
            client_id: row.get("client_id")?,
            name: row.get("name")?,
            kind: row.get("kind")?,
            redirect_uris: row.get("redirect_uris")?,
            allowed_scopes: row.get("allowed_scopes")?,
            allowed_grant_types: row.get("allowed_grant_types")?,
            secret_hash: row.get("secret_hash")?,
            registered_at: row.get("registered_at")?,
            disabled_at: row.get("disabled_at")?,
        })
    }
}

fn make_named_sql_params(client: &Client) -> [(&str, &dyn ToSql); 9] {
    [
        (":client_id", &client.client_id),
        (":name", &client.name),
        (":kind", &client.kind),
        (":redirect_uris", &client.redirect_uris),
        (":allowed_scopes", &client.allowed_scopes),
        (":allowed_grant_types", &client.allowed_grant_types),
        (":secret_hash", &client.secret_hash),
        (":registered_at", &client.registered_at),
        (":disabled_at", &client.disabled_at),
    ]
}

impl GatekeeperStore {
    /// Look up a registered client by its `client_id`.
    ///
    /// # Errors
    ///
    /// Returns a `rusqlite::Error` if the select query fails or a returned row
    /// cannot be mapped to a [`Client`].
    pub fn client_by_id(&self, client_id: &str) -> DbResult<Option<Client>> {
        self.conn()
            .lock()
            .query_row(
                &format!("SELECT {ALL_COLS} FROM clients WHERE client_id = ?1"),
                params![client_id],
                |row| Client::try_from(row),
            )
            .optional()
    }

    /// Persist a new OAuth client.
    ///
    /// # Errors
    ///
    /// Returns a `rusqlite::Error` if the insert fails (for example a
    /// unique-constraint violation on the `client_id`).
    pub fn register_client(&self, client: &Client) -> DbResult<()> {
        let params = make_named_sql_params(client);
        self.conn()
            .lock()
            .execute(&build_insert_sql("clients", &params), &params)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::{arb_opt_timestamp, arb_timestamp, arb_url};
    use crate::db_utils::JsonColumn;
    use crate::domain::client::{AllowedGrantType, ClientKind};
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
}
