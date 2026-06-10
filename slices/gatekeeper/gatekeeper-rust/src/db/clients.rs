use anyhow::Context;
use chrono::Utc;
use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ToSqlOutput, ValueRef};
use rusqlite::{params, OptionalExtension, Row, ToSql};

use super::GatekeeperStore;
use crate::domain::client::{Client, ClientKind};
use crate::json::Json;
use crate::{FIRST_PARTY_CLIENT_ID, OWNER_SCOPE};

impl ToSql for ClientKind {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(ToSqlOutput::Borrowed(ValueRef::Text(
            self.as_str().as_bytes(),
        )))
    }
}

impl FromSql for ClientKind {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        let s = value.as_str()?;
        ClientKind::parse(s)
            .ok_or_else(|| FromSqlError::Other(format!("unknown client kind {s}").into()))
    }
}

impl TryFrom<&Row<'_>> for Client {
    type Error = rusqlite::Error;
    fn try_from(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Client {
            client_id: row.get("clientId")?,
            name: row.get("name")?,
            kind: row.get("kind")?,
            redirect_uris: row.get("redirectUris")?,
            allowed_scopes: row.get("allowedScopes")?,
            secret_hash: row.get("secretHash")?,
            registered_at: row.get("registeredAt")?,
            disabled_at: row.get("disabledAt")?,
        })
    }
}

impl Client {
    pub(in crate::db) fn as_named_sql_params(&self) -> [(&str, &dyn ToSql); 8] {
        [
            (":clientId", &self.client_id),
            (":name", &self.name),
            (":kind", &self.kind),
            (":redirectUris", &self.redirect_uris),
            (":allowedScopes", &self.allowed_scopes),
            (":secretHash", &self.secret_hash),
            (":registeredAt", &self.registered_at),
            (":disabledAt", &self.disabled_at),
        ]
    }
}

impl GatekeeperStore {
    pub fn client_by_id(&self, client_id: &str) -> crate::db::DbResult<Option<Client>> {
        self.conn()
            .lock()
            .query_row(
                "SELECT clientId, name, kind, redirectUris, allowedScopes, secretHash, registeredAt, disabledAt
                 FROM clients WHERE clientId = ?1",
                params![client_id],
                |row| Client::try_from(row),
            )
            .optional()
    }

    pub fn register_client(&self, client: &Client) -> crate::db::DbResult<()> {
        self.conn().lock().execute(
            "INSERT INTO clients
             (clientId, name, kind, redirectUris, allowedScopes, secretHash, registeredAt, disabledAt)
             VALUES (:clientId, :name, :kind, :redirectUris, :allowedScopes, :secretHash, :registeredAt, :disabledAt)",
            &client.as_named_sql_params(),
        )?;
        Ok(())
    }

    /// Register the `wildflower-host` first-party client if it isn't already
    /// in the store. Idempotent — safe to call on every boot.
    pub fn ensure_first_party_client(&self) -> anyhow::Result<()> {
        if self
            .client_by_id(FIRST_PARTY_CLIENT_ID)
            .context("read first-party client")?
            .is_some()
        {
            return Ok(());
        }
        let client = Client {
            client_id: FIRST_PARTY_CLIENT_ID.to_string(),
            name: "Wildflower (host)".to_string(),
            kind: ClientKind::Public,
            redirect_uris: Json(vec![]),
            allowed_scopes: Json(vec![OWNER_SCOPE.to_string()]),
            secret_hash: None,
            registered_at: Utc::now(),
            disabled_at: None,
        };
        self.register_client(&client)
            .context("register first-party client")?;
        Ok(())
    }
}
