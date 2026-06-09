use rusqlite::{params, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use super::GatekeeperStore;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ClientKind {
    Public,
    Confidential,
}

impl ClientKind {
    fn as_str(&self) -> &'static str {
        match self {
            ClientKind::Public => "public",
            ClientKind::Confidential => "confidential",
        }
    }
    fn parse(s: &str) -> Option<ClientKind> {
        match s {
            "public" => Some(ClientKind::Public),
            "confidential" => Some(ClientKind::Confidential),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ClientRow {
    pub client_id: String,
    pub name: String,
    pub kind: ClientKind,
    pub redirect_uris: Vec<String>,
    pub allowed_scopes: Vec<String>,
    pub secret_hash: Option<String>,
    pub registered_at: String,
    pub disabled_at: Option<String>,
}

fn row_to_client(row: &Row) -> rusqlite::Result<ClientRow> {
    let kind_str: String = row.get("kind")?;
    let redirect_uris_json: String = row.get("redirectUris")?;
    let allowed_scopes_json: String = row.get("allowedScopes")?;
    Ok(ClientRow {
        client_id: row.get("clientId")?,
        name: row.get("name")?,
        kind: ClientKind::parse(&kind_str)
            .ok_or_else(|| rusqlite::Error::InvalidQuery)?,
        redirect_uris: serde_json::from_str(&redirect_uris_json)
            .map_err(|_| rusqlite::Error::InvalidQuery)?,
        allowed_scopes: serde_json::from_str(&allowed_scopes_json)
            .map_err(|_| rusqlite::Error::InvalidQuery)?,
        secret_hash: row.get("secretHash")?,
        registered_at: row.get("registeredAt")?,
        disabled_at: row.get("disabledAt")?,
    })
}

impl GatekeeperStore {
    pub async fn client_by_id(&self, client_id: &str) -> crate::store::DbResult<Option<ClientRow>> {
        let id = client_id.to_string();
        self.conn()
            .call(move |c| {
                let row = c
                    .query_row(
                        "SELECT clientId, name, kind, redirectUris, allowedScopes, secretHash, registeredAt, disabledAt
                         FROM clients WHERE clientId = ?1",
                        params![id],
                        row_to_client,
                    )
                    .optional()?;
                Ok(row)
            })
            .await
    }

    pub async fn register_client(&self, row: ClientRow) -> crate::store::DbResult<()> {
        self.conn()
            .call(move |c| {
                c.execute(
                    "INSERT INTO clients
                     (clientId, name, kind, redirectUris, allowedScopes, secretHash, registeredAt, disabledAt)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    params![
                        row.client_id,
                        row.name,
                        row.kind.as_str(),
                        serde_json::to_string(&row.redirect_uris).unwrap(),
                        serde_json::to_string(&row.allowed_scopes).unwrap(),
                        row.secret_hash,
                        row.registered_at,
                        row.disabled_at,
                    ],
                )?;
                Ok(())
            })
            .await
    }
}
