//! Request / client / grant fixtures the per-entity domain tests share.

use chrono::{DateTime, Duration, Utc};
use url::Url;

use crate::domain::authorization_request::{AuthorizationRequest, GrantType, RequestStatus};
use crate::domain::client::{AllowedGrantType, Client, ClientKind};
use crate::domain::grant::AuthorizationCodeGrant;

/// A pending (by default) device-code authorization request fixture.
pub(crate) fn device_request(
    id: &str,
    user_code: &str,
    status: RequestStatus,
) -> AuthorizationRequest {
    let now = Utc::now();
    AuthorizationRequest {
        id: id.to_owned(),
        grant_type: GrantType::DeviceCode,
        client_id: "client".to_owned(),
        requested_scopes: vec!["openid".to_owned()],
        code_challenge: None,
        code_challenge_method: None,
        redirect_uri: None,
        client_state: None,
        user_code: Some(user_code.to_owned()),
        pre_approved_scopes: Vec::new(),
        requested_at: now,
        expires_at: now + Duration::minutes(5),
        last_polled_at: None,
        status,
        granted_scopes: None,
        patient: None,
        device_name: None,
    }
}

/// A well-formed authorization-code request fixture (populated `redirect_uri` +
/// PKCE `code_challenge`) with a caller-chosen `status` and `expires_at`.
pub(crate) fn code_request(
    id: &str,
    status: RequestStatus,
    expires_at: DateTime<Utc>,
) -> AuthorizationRequest {
    AuthorizationRequest {
        id: id.to_owned(),
        grant_type: GrantType::AuthorizationCode,
        client_id: "client".to_owned(),
        requested_scopes: vec!["read".to_owned()],
        code_challenge: Some("c".repeat(43)),
        code_challenge_method: Some("S256".to_owned()),
        redirect_uri: Some(Url::parse("https://example.com/cb").unwrap()),
        client_state: Some("state".to_owned()),
        user_code: None,
        pre_approved_scopes: Vec::new(),
        requested_at: Utc::now(),
        expires_at,
        last_polled_at: None,
        status,
        granted_scopes: None,
        patient: None,
        device_name: None,
    }
}

/// A public-client fixture with a caller-chosen `allowed_scopes` set and the
/// `https://example.com/cb` redirect the request fixtures use.
pub(crate) fn client(client_id: &str, allowed_scopes: &[&str]) -> Client {
    Client {
        client_id: client_id.to_owned(),
        name: format!("{client_id} display name"),
        kind: ClientKind::Public,
        redirect_uris: vec![Url::parse("https://example.com/cb").unwrap().into()],
        allowed_scopes: allowed_scopes.iter().map(|s| (*s).to_owned()).collect(),
        allowed_grant_types: AllowedGrantType::ALL.to_vec(),
        secret_hash: None,
        registered_at: Utc::now(),
        disabled_at: None,
    }
}

/// An authorization-code grant fixture.
pub(crate) fn code_grant(id: &str, client_id: &str) -> AuthorizationCodeGrant {
    AuthorizationCodeGrant {
        id: id.to_owned(),
        client_id: client_id.to_owned(),
        scopes: vec!["read".to_owned()],
        granted_at: Utc::now(),
        last_used_at: None,
        patient: None,
        redirect_uri: Url::parse("https://example.com/cb").unwrap(),
    }
}
