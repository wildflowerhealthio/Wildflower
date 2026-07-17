use chrono::Utc;

use crate::crypto_util::random_token::{generate_refresh_token, token_storage_hash};
use crate::domain::client::AllowedGrantType;
use crate::domain::oauth_error_code::OAuthErrorCode;
use crate::domain::refresh_token::{RefreshToken, RefreshTokenConsumeOutcome};
use crate::domain::GatekeeperStore;
use crate::http::routes::oauth::client_auth::ClientCredentials;
use crate::http::routes::oauth::internal::{
    issue_token_response, require_valid_client_for_token, IssueTokenInput, TokenError,
};
use crate::http::state::GatekeeperState;
use crate::http::wire_representations::TokenResponse;

/// Redeem a refresh token (RFC 6749 §6) with rotation semantics: the
/// presented token is consumed and its successor returned. Presenting an
/// already-consumed token is treated as theft — the whole family is revoked
/// (OAuth 2.1 refresh-token rotation).
pub(super) fn exchange_refresh_token(
    state: &GatekeeperState,
    origin: &str,
    presented_credentials: &ClientCredentials,
    presented_refresh_token: &str,
) -> Result<TokenResponse, TokenError> {
    let client = require_valid_client_for_token(&state.store, presented_credentials)?;
    if !client
        .allowed_grant_types
        .contains(&AllowedGrantType::RefreshToken)
    {
        return Err(TokenError::bad_request(
            OAuthErrorCode::UnauthorizedClient,
            Some("Client may not use this grant type"),
        ));
    }
    let hash = token_storage_hash(presented_refresh_token);
    let Some((_, family)) = state.store.refresh_token_with_family_by_hash(&hash)? else {
        tracing::warn!("refresh_token grant rejected: token not found");
        return Err(TokenError::bad_request(
            OAuthErrorCode::InvalidGrant,
            Some("Invalid refresh_token parameter"),
        ));
    };
    // Token–client binding (RFC 6749 §6): a valid token presented by the
    // wrong client is a grant failure; answer exactly as if it didn't exist.
    // Checked before consuming so a stranger can't burn the rightful
    // client's live token.
    if family.client_id != presented_credentials.client_id {
        // Deliberately answered exactly like "not found" (RFC 6749 §6) so a
        // stranger can't probe token validity; log the real reason.
        tracing::warn!(
            family_client_id = %family.client_id,
            presented_client_id = %presented_credentials.client_id,
            "refresh_token grant rejected: token belongs to a different client"
        );
        return Err(TokenError::bad_request(
            OAuthErrorCode::InvalidGrant,
            Some("Invalid refresh_token parameter"),
        ));
    }
    let now = Utc::now();
    // Covers both natural deadline passage and prior revocation — revoking
    // pulls `expires_at` back to the revocation instant rather than deleting
    // rows, so the lineage stays auditable.
    if family.expires_at <= now {
        return Err(TokenError::bad_request(
            OAuthErrorCode::InvalidGrant,
            Some("Refresh token has expired"),
        ));
    }
    // Mint the access token BEFORE mutating any state: a signing failure then
    // returns 500 without burning the presented token, so the client can
    // safely retry. The family keeps its scopes and absolute deadline
    // (rotation never extends its life).
    let mut token = issue_token_response(
        &state.store,
        &IssueTokenInput {
            client_id: &family.client_id,
            granted_scopes: &family.scopes,
            patient: family.patient.as_deref(),
            origin,
        },
    )
    .map_err(TokenError::server_error)?;
    let next_plaintext = generate_refresh_token();
    let next = RefreshToken {
        token_hash: token_storage_hash(&next_plaintext),
        family_id: family.family_id.clone(),
        issued_at: now,
        consumed_at: None,
    };
    // Consume the presented token, and only if that consume won insert its
    // successor. The consume is atomic on its own; the successor insert is a
    // separate step, ordered after it — so a failure of the insert leaves the
    // presented token spent with no successor (a failed rotation the client
    // recovers from by re-authorizing), never a usable extra token. See
    // `crate::domain::refresh_token::rotate_refresh_token` for the ordered-consume-then-insert
    // rationale.
    match crate::domain::refresh_token::rotate_refresh_token(&state.store, &hash, &next, now)? {
        RefreshTokenConsumeOutcome::Consumed => {}
        // A consumed token can only reappear if it leaked (or the client is
        // badly broken) — also where a concurrent redeemer of the same
        // plaintext lands. Either way the lineage is unsafe: end the family
        // by expiring it at this instant.
        RefreshTokenConsumeOutcome::Replayed => {
            tracing::warn!(
                family_id = %family.family_id,
                client_id = %family.client_id,
                "refresh_token grant rejected: replay of a consumed token — revoking the whole family (possible theft)"
            );
            state
                .store
                .expire_refresh_token_family(&family.family_id, now)?;
            return Err(TokenError::bad_request(
                OAuthErrorCode::InvalidGrant,
                Some("Refresh token has been revoked"),
            ));
        }
        // Vanished between lookup and rotate — a failed decode, nothing left
        // to revoke.
        RefreshTokenConsumeOutcome::NotFound => {
            tracing::warn!(
                family_id = %family.family_id,
                "refresh_token grant rejected: token vanished between lookup and rotate"
            );
            return Err(TokenError::bad_request(
                OAuthErrorCode::InvalidGrant,
                Some("Invalid refresh_token parameter"),
            ));
        }
    }
    token.refresh_token = Some(next_plaintext);
    Ok(token)
}
