use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::json::Json;

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
