//! `POST /oauth/revoke` — RFC 7009 token revocation. A client presents one of
//! its own tokens, authenticating as it does at `/oauth/token` (a public
//! client by its `client_id`, a confidential one by its secret too). See
//! [`ClientTokenRevoker`](crate::domain::capabilities::oauth::ClientTokenRevoker)
//! for what is revoked.

use axum::http::StatusCode;
use chrono::Utc;
use serde::Deserialize;

use super::internal::TokenError;
use super::openapi::TokenRevocationRequestBody;
use super::token_request::TokenRequest;
use crate::http::extractors::Live;
use crate::http::wire_representations::OAuthError;
use crate::live_bindings::LiveClientTokenRevoker;

/// Body of an RFC 7009 §2.1 revocation request. Client credentials are parsed
/// by the [`TokenRequest`] extractor, and `token_type_hint` is not read: the
/// revoker tells the token's type from the token (§2.1 lets the server search
/// every type it supports).
#[derive(Debug, Deserialize)]
pub struct TokenRevocationPayload {
    /// The access or refresh token to revoke.
    token: String,
}

/// Revoke the presented token. RFC 7009 §2.2: `200` whether the token was
/// revoked, was already dead, or was never one of this client's.
#[utoipa::path(
    post,
    tag = "OAuth 2.0",
    path = "/revoke",
    request_body(content = TokenRevocationRequestBody, content_type = "application/x-www-form-urlencoded"),
    responses(
        (status = 200, description = "Revoked, or not a live token of this client's (RFC 7009 §2.2)"),
        (status = 400, description = "Malformed request (RFC 7009 §2.2.1)", body = OAuthError),
        (status = 401, description = "Client authentication failed (RFC 7009 §2.2.1)", body = OAuthError),
        (status = 500, description = "Server error", body = OAuthError)
    )
)]
pub(super) async fn handle_token_revocation_request(
    revoker: Live<LiveClientTokenRevoker>,
    request: TokenRequest<TokenRevocationPayload>,
) -> Result<StatusCode, TokenError> {
    let TokenRequest {
        payload,
        authenticated_client,
    } = request;
    revoker.revoke(&authenticated_client, &payload.token, Utc::now())?;
    Ok(StatusCode::OK)
}
