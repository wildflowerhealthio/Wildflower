use anyhow::Context;
use chrono::{DateTime, Utc};
use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ToSqlOutput, ValueRef};
use rusqlite::{params, OptionalExtension, Row, ToSql};
use serde::{Deserialize, Serialize};

use super::types::Json;
use super::GatekeeperStore;
use crate::{FIRST_PARTY_CLIENT_ID, OWNER_SCOPE};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ClientKind {
    Public,
    Confidential,
}

impl ClientKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            ClientKind::Public => "public",
            ClientKind::Confidential => "confidential",
        }
    }
    pub fn parse(s: &str) -> Option<ClientKind> {
        match s {
            "public" => Some(ClientKind::Public),
            "confidential" => Some(ClientKind::Confidential),
            _ => None,
        }
    }
}

impl ToSql for ClientKind {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(ToSqlOutput::Borrowed(ValueRef::Text(self.as_str().as_bytes())))
    }
}

impl FromSql for ClientKind {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        let s = value.as_str()?;
        ClientKind::parse(s).ok_or_else(|| FromSqlError::Other(format!("unknown client kind {s}").into()))
    }
}

#[derive(Debug, Clone)]
pub struct Client {
    pub client_id: String,
    pub name: String,
    pub kind: ClientKind,
    pub redirect_uris: Json<Vec<String>>,
    pub allowed_scopes: Json<Vec<String>>,
    pub secret_hash: Option<String>,
    pub registered_at: DateTime<Utc>,
    pub disabled_at: Option<DateTime<Utc>>,
}

impl Client {
    pub fn as_named_sql_params(&self) -> [(&str, &dyn ToSql); 8] {
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

impl GatekeeperStore {
    pub fn client_by_id(&self, client_id: &str) -> crate::store::DbResult<Option<Client>> {
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

    pub fn register_client(&self, client: &Client) -> crate::store::DbResult<()> {
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
