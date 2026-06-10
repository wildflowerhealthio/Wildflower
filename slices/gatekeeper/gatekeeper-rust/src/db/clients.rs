use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ToSqlOutput, ValueRef};
use rusqlite::{params, OptionalExtension, Row, ToSql};

use super::GatekeeperStore;
use crate::db_utils::sql_builder::build_insert_sql;
use crate::domain::client::{Client, ClientKind};

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
            .map_err(|_| FromSqlError::Other(format!("unknown client kind {s}").into()))
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
            secret_hash: row.get("secret_hash")?,
            registered_at: row.get("registered_at")?,
            disabled_at: row.get("disabled_at")?,
        })
    }
}

fn make_named_sql_params(client: &Client) -> [(&str, &dyn ToSql); 8] {
    [
        (":client_id", &client.client_id),
        (":name", &client.name),
        (":kind", &client.kind),
        (":redirect_uris", &client.redirect_uris),
        (":allowed_scopes", &client.allowed_scopes),
        (":secret_hash", &client.secret_hash),
        (":registered_at", &client.registered_at),
        (":disabled_at", &client.disabled_at),
    ]
}

impl GatekeeperStore {
    pub fn client_by_id(&self, client_id: &str) -> crate::db::DbResult<Option<Client>> {
        self.conn()
            .lock()
            .query_row(
                "SELECT client_id, name, kind, redirect_uris, allowed_scopes, secret_hash, registered_at, disabled_at
                 FROM clients WHERE client_id = ?1",
                params![client_id],
                |row| Client::try_from(row),
            )
            .optional()
    }

    pub fn register_client(&self, client: &Client) -> crate::db::DbResult<()> {
        let params = make_named_sql_params(client);
        self.conn()
            .lock()
            .execute(
                &build_insert_sql("clients", &params),
                &params,
            )?;
        Ok(())
    }
}
