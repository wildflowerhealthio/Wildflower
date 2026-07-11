//! Durable consent records — one concrete struct per grant kind, each owning
//! ALL of its fields (shared and payload alike) and diesel-mapped straight to
//! its own table:
//!
//! - [`AuthorizationCodeGrant`] carries the exact `redirect_uri` it covers, so
//!   `/authorize` can skip the consent prompt for a returning
//!   `(client_id, redirect_uri)` pair;
//! - [`DeviceGrant`] carries the paired `device_name`, so an owner can see
//!   which devices they've authorized in Settings.
//!
//! The kinds share **behaviour**, not structure: [`CumulativeConsent`] is the
//! re-approval rule (scope union — approving a narrower request never
//! withdraws earlier consent), and the thin [`Grant`] enum is the wire/list
//! seam — its internally-tagged serde keeps the `grantType`-tagged JSON the
//! `access-management` `GrantSchema` decodes byte-identical to the old
//! polymorphic-rows implementation. Single-kind operations (upserts, keyed
//! lookups) never touch the enum; cross-kind reads come off the `grants` SQL
//! VIEW in [`crate::db`].

use chrono::{DateTime, Utc};
use diesel::prelude::{Insertable, Queryable, Selectable};
use serde::Serialize;
use url::Url;

use crate::db::columns::{JsonStrings, UrlText};
use crate::db::schema::{authorization_code_grants, device_grants};

/// A standing authorization-code consent: "OAuth client X may ask for scopes Y
/// at redirect URI Z without re-prompting the Owner." Diesel-mapped 1:1 to the
/// `authorization_code_grants` table; on the wire it rides inside
/// [`Grant::AuthorizationCode`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Queryable, Selectable, Insertable)]
#[serde(rename_all = "camelCase")]
#[diesel(table_name = authorization_code_grants)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub struct AuthorizationCodeGrant {
    /// Primary key — a UUID minted at first upsert, unique across BOTH grant
    /// tables (so a bare grant id read through the `grants` view is
    /// unambiguous).
    pub id: String,
    /// `client_id` the Owner approved this grant for.
    pub client_id: String,
    /// Scopes the Owner approved; consent is cumulative (see
    /// [`CumulativeConsent`]).
    #[diesel(serialize_as = JsonStrings, deserialize_as = JsonStrings)]
    pub scopes: Vec<String>,
    /// When the Owner gave (or last re-confirmed) consent.
    pub granted_at: DateTime<Utc>,
    /// Last time this grant short-circuited a consent decision; `None` until
    /// first use.
    pub last_used_at: Option<DateTime<Utc>>,
    /// SMART-on-FHIR patient context recorded at approval, carried forward to
    /// future codes/tokens minted under this grant.
    pub patient: Option<String>,
    /// The exact redirect URI this grant covers — `/authorize` keys the
    /// consent-skip fast path on `(client_id, redirect_uri)`.
    #[diesel(serialize_as = UrlText, deserialize_as = UrlText)]
    pub redirect_uri: Url,
}

/// A standing device pairing: the durable record of an approved device-code
/// flow, keyed on the human-facing device name. Diesel-mapped 1:1 to the
/// `device_grants` table; on the wire it rides inside [`Grant::DeviceCode`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Queryable, Selectable, Insertable)]
#[serde(rename_all = "camelCase")]
#[diesel(table_name = device_grants)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub struct DeviceGrant {
    /// Primary key — a UUID minted at first upsert, unique across BOTH grant
    /// tables.
    pub id: String,
    /// `client_id` the Owner approved this pairing for.
    pub client_id: String,
    /// Scopes the Owner approved; consent is cumulative (see
    /// [`CumulativeConsent`]).
    #[diesel(serialize_as = JsonStrings, deserialize_as = JsonStrings)]
    pub scopes: Vec<String>,
    /// When the Owner gave (or last re-confirmed) consent.
    pub granted_at: DateTime<Utc>,
    /// Last time this grant short-circuited a consent decision; `None` until
    /// first use.
    pub last_used_at: Option<DateTime<Utc>>,
    /// SMART-on-FHIR patient context recorded at approval.
    pub patient: Option<String>,
    /// The human-facing device name this pairing is keyed on. Defaults to
    /// the client's name when the device didn't name itself.
    pub device_name: String,
}

/// The re-approval rule both grant kinds share — behaviour, not structure:
/// consent is **cumulative**. A later approval unions its scopes into the
/// standing set (order-preserving, no duplicates) and refreshes the consent
/// instant and patient context; approving a narrower request never withdraws
/// previously-consented scopes — revoking the grant is the way to withdraw.
pub trait CumulativeConsent {
    /// Fold a re-approval into this standing grant: union `additional` scopes
    /// in, stamp `granted_at = at`, and adopt the re-approval's `patient`.
    fn absorb_reapproval(
        &mut self,
        additional: &[String],
        patient: Option<&str>,
        at: DateTime<Utc>,
    );
}

impl CumulativeConsent for AuthorizationCodeGrant {
    fn absorb_reapproval(
        &mut self,
        additional: &[String],
        patient: Option<&str>,
        at: DateTime<Utc>,
    ) {
        union_scopes_into(&mut self.scopes, additional);
        self.granted_at = at;
        self.patient = patient.map(str::to_owned);
    }
}

impl CumulativeConsent for DeviceGrant {
    fn absorb_reapproval(
        &mut self,
        additional: &[String],
        patient: Option<&str>,
        at: DateTime<Utc>,
    ) {
        union_scopes_into(&mut self.scopes, additional);
        self.granted_at = at;
        self.patient = patient.map(str::to_owned);
    }
}

/// Union `additional` scopes into `standing`, preserving order and skipping
/// duplicates — the shared half of [`CumulativeConsent`].
fn union_scopes_into(standing: &mut Vec<String>, additional: &[String]) {
    for scope in additional {
        if !standing.contains(scope) {
            standing.push(scope.clone());
        }
    }
}

/// The wire/list seam over the two concrete grant kinds — what cross-kind
/// reads (`all_grants`, `grant_by_id`) return and what the `/access/grants`
/// endpoints serialize. Internally-tagged on `grantType` with the snake_case
/// kind names, so each variant serializes as its struct's camelCase fields
/// with the tag alongside — the exact `grantType`-tagged union the TS
/// `access-management` `GrantSchema` decodes (pinned by the tests below).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "grantType", rename_all = "snake_case")]
pub enum Grant {
    AuthorizationCode(AuthorizationCodeGrant),
    DeviceCode(DeviceGrant),
}

impl Grant {
    /// The grant's id — shared by both kinds (UUIDs, unique across both
    /// tables), read at the seam without unpacking the kind.
    #[must_use]
    pub fn id(&self) -> &str {
        match self {
            Grant::AuthorizationCode(grant) => &grant.id,
            Grant::DeviceCode(grant) => &grant.id,
        }
    }

    /// The `client_id` the grant covers — the revoke path expires this
    /// client's refresh-token families alongside the grant.
    #[must_use]
    pub fn client_id(&self) -> &str {
        match self {
            Grant::AuthorizationCode(grant) => &grant.client_id,
            Grant::DeviceCode(grant) => &grant.client_id,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn code_grant() -> AuthorizationCodeGrant {
        AuthorizationCodeGrant {
            id: "grant-x".to_owned(),
            client_id: "client-a".to_owned(),
            scopes: vec!["read".to_owned(), "offline_access".to_owned()],
            granted_at: "2024-01-01T00:00:00Z".parse().expect("timestamp"),
            last_used_at: None,
            patient: None,
            redirect_uri: Url::parse("https://example.com/cb").expect("url"),
        }
    }

    fn device_grant() -> DeviceGrant {
        DeviceGrant {
            id: "grant-x".to_owned(),
            client_id: "client-a".to_owned(),
            scopes: vec!["read".to_owned(), "offline_access".to_owned()],
            granted_at: "2024-01-01T00:00:00Z".parse().expect("timestamp"),
            last_used_at: None,
            patient: None,
            device_name: "Ada's laptop".to_owned(),
        }
    }

    fn to_json(grant: &Grant) -> serde_json::Value {
        serde_json::to_value(grant).expect("grant serializes")
    }

    /// An authorization-code grant serializes as the `authorization_code`
    /// variant: the `grantType` tag and `redirectUri` sit alongside the shared
    /// fields, with an absent `patient`/`lastUsedAt` rendered as `null` — the
    /// exact JSON the old polymorphic `Grant` produced, so the TS
    /// `access-management` `GrantSchema` can't notice the storage restructure.
    #[test]
    fn authorization_code_grant_serializes_exactly() {
        let grant = Grant::AuthorizationCode(code_grant());
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
        let mut inner = device_grant();
        inner.patient = Some("patient-1".to_owned());
        let grant = Grant::DeviceCode(inner);
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

    /// The shared re-approval behaviour: scopes union (order-preserving, no
    /// duplicates — a narrower re-approval withdraws nothing), and the consent
    /// instant + patient context refresh. Exercised through the trait so both
    /// kinds share one rule.
    #[test]
    fn absorb_reapproval_unions_scopes_and_refreshes_consent() {
        let later: DateTime<Utc> = "2025-06-01T00:00:00Z".parse().expect("timestamp");

        let mut code = code_grant();
        code.absorb_reapproval(
            &["read".to_owned(), "write".to_owned()],
            Some("pat-2"),
            later,
        );
        assert_eq!(
            code.scopes,
            vec![
                "read".to_owned(),
                "offline_access".to_owned(),
                "write".to_owned()
            ],
        );
        assert_eq!(code.granted_at, later);
        assert_eq!(code.patient.as_deref(), Some("pat-2"));

        let mut device = device_grant();
        device.absorb_reapproval(&["read".to_owned()], None, later);
        assert_eq!(
            device.scopes,
            vec!["read".to_owned(), "offline_access".to_owned()],
            "a narrower re-approval never un-approves earlier consent",
        );
        assert_eq!(device.granted_at, later);
        assert_eq!(device.patient, None);
    }
}
