use chrono::{DateTime, Utc};
use serde::Serialize;

use persistence_rust::{JsonColumn, UriColumn};

use crate::domain::authorization_request::GrantType;

/// A durable consent decision: the Owner approved a client for a scope set at a
/// point in time. A grant is **polymorphic** — the fields every flow shares live
/// here, and the flow-specific payload lives in [`GrantKind`]:
///
/// - an **authorization-code** grant carries the exact `redirect_uri` it covers,
///   so `/authorize` can skip the consent prompt for a returning
///   `(client_id, redirect_uri)` pair;
/// - a **device-code** grant carries the paired `device_name`, so an owner can
///   see which devices they've authorized in Settings.
///
/// The stored `grants.grant_type` discriminator maps to the variant, never to a
/// separate field — [`GrantKind::grant_type`] derives it — so a grant can't claim
/// one kind while carrying another's payload. On the wire it serializes as a
/// `grantType`-tagged union (the tag + the variant's payload flattened onto the
/// shared fields), mirroring the storage shape 1:1.
///
/// `lastUsedAt` is `None` until the first time a token minted from this grant is
/// used.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Grant {
    /// Primary key — internal UUID for the grant row (the parent `grants.id`).
    pub id: String,
    /// `client_id` the Owner approved this grant for.
    pub client_id: String,
    /// Scopes the Owner approved; consent is cumulative (re-approval unions).
    pub scopes: JsonColumn<Vec<String>>,
    /// When the Owner gave (or last re-confirmed) consent.
    pub granted_at: DateTime<Utc>,
    /// Last time this grant short-circuited a consent decision; `None` until
    /// first use.
    pub last_used_at: Option<DateTime<Utc>>,
    /// SMART-on-FHIR patient context recorded at approval, carried forward to
    /// future codes/tokens minted under this grant.
    pub patient: Option<String>,
    /// The flow-specific payload. Flattened on the wire so the `grantType` tag
    /// and the variant's fields sit alongside the shared fields above.
    #[serde(flatten)]
    pub kind: GrantKind,
}

/// The flow-specific grant payload. The variant *is* the stored `grant_type`
/// ([`Self::grant_type`] derives the column value), so the discriminator and the
/// payload can never disagree.
///
/// Serialized internally-tagged on `grantType` (matching the `GrantType` wire
/// strings) with camelCase payload fields — the discriminated-union wire shape
/// the `access-management` `GrantSchema` mirrors.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "grantType", rename_all = "snake_case")]
pub enum GrantKind {
    /// An authorization-code grant (`authorization_code_grants` child).
    #[serde(rename_all = "camelCase")]
    AuthorizationCode {
        /// The exact redirect URI this grant covers — `/authorize` keys the
        /// consent-skip fast path on `(client_id, redirect_uri)`.
        redirect_uri: UriColumn,
    },
    /// A device-code grant (`device_grants` child).
    #[serde(rename_all = "camelCase")]
    DeviceCode {
        /// The human-facing device name this pairing is keyed on. Defaults to
        /// the client's name when the device didn't name itself.
        device_name: String,
    },
}

impl GrantKind {
    /// The `grant_type` discriminant this variant stores/serializes as — the
    /// single source of truth for the parent's `grant_type` column and the wire
    /// tag.
    #[must_use]
    pub fn grant_type(&self) -> GrantType {
        match self {
            GrantKind::AuthorizationCode { .. } => GrantType::AuthorizationCode,
            GrantKind::DeviceCode { .. } => GrantType::DeviceCode,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use url::Url;

    fn base_grant(kind: GrantKind) -> Grant {
        Grant {
            id: "grant-x".to_owned(),
            client_id: "client-a".to_owned(),
            scopes: JsonColumn(vec!["read".to_owned(), "offline_access".to_owned()]),
            granted_at: "2024-01-01T00:00:00Z".parse().expect("timestamp"),
            last_used_at: None,
            patient: None,
            kind,
        }
    }

    fn to_json(grant: &Grant) -> serde_json::Value {
        serde_json::to_value(grant).expect("grant serializes")
    }

    /// The variant is the discriminator — one source of truth per kind.
    #[test]
    fn grant_type_derives_from_the_kind() {
        let redirect_uri = UriColumn(Url::parse("https://example.com/cb").unwrap());
        assert_eq!(
            GrantKind::AuthorizationCode { redirect_uri }.grant_type(),
            GrantType::AuthorizationCode,
        );
        assert_eq!(
            GrantKind::DeviceCode {
                device_name: "Ada's laptop".to_owned(),
            }
            .grant_type(),
            GrantType::DeviceCode,
        );
    }

    /// An authorization-code grant serializes as the `authorization_code`
    /// variant: the `grantType` tag and `redirectUri` sit alongside the shared
    /// fields, with an absent `patient`/`lastUsedAt` rendered as `null`.
    #[test]
    fn authorization_code_grant_serializes_exactly() {
        let grant = base_grant(GrantKind::AuthorizationCode {
            redirect_uri: UriColumn(Url::parse("https://example.com/cb").unwrap()),
        });
        assert_eq!(
            to_json(&grant),
            serde_json::json!({
                "id": "grant-x",
                "clientId": "client-a",
                "scopes": ["read", "offline_access"],
                "grantedAt": "2024-01-01T00:00:00Z",
                "lastUsedAt": null,
                "patient": null,
                "grantType": "authorization_code",
                "redirectUri": "https://example.com/cb",
            }),
        );
    }

    /// A device-code grant serializes as the `device_code` variant carrying
    /// `deviceName`; a present `patient` surfaces alongside.
    #[test]
    fn device_grant_serializes_exactly() {
        let mut grant = base_grant(GrantKind::DeviceCode {
            device_name: "Ada's laptop".to_owned(),
        });
        grant.patient = Some("patient-1".to_owned());
        assert_eq!(
            to_json(&grant),
            serde_json::json!({
                "id": "grant-x",
                "clientId": "client-a",
                "scopes": ["read", "offline_access"],
                "grantedAt": "2024-01-01T00:00:00Z",
                "lastUsedAt": null,
                "patient": "patient-1",
                "grantType": "device_code",
                "deviceName": "Ada's laptop",
            }),
        );
    }
}
