use chrono::Utc;
use subtle::ConstantTimeEq;
use url::Url;

use super::{issue_token, start_refresh_token_family_if_granted, AuthorizationCodeGrant};
use crate::crypto_util::pkce::{compute_code_challenge, is_valid_code_verifier_length};
use crate::crypto_util::random_token::token_storage_hash;
use crate::domain::authorization_code::AuthorizationCode;
use crate::domain::client::AllowedGrantType;
use crate::domain::oauth_error_code::OAuthErrorCode;
use crate::domain::GatekeeperStore;
use crate::http::routes::oauth::client_auth::ClientCredentials;
use crate::http::routes::oauth::internal::{
    require_valid_client_for_token, IssueTokenInput, TokenError,
};
use crate::http::state::GatekeeperState;
use crate::http::wire_representations::TokenResponse;

pub(super) fn exchange_authorization_code(
    state: &GatekeeperState,
    origin: &str,
    presented_credentials: &ClientCredentials,
    grant: &AuthorizationCodeGrant<'_>,
) -> Result<TokenResponse, TokenError> {
    let client = require_valid_client_for_token(&state.store, presented_credentials)?;
    if !client
        .allowed_grant_types
        .contains(&AllowedGrantType::AuthorizationCode)
    {
        return Err(TokenError::bad_request(
            OAuthErrorCode::UnauthorizedClient,
            Some("Client may not use this grant type"),
        ));
    }
    // RFC 7636 §4.1: the verifier is 43–128 chars. Reject out-of-range values
    // before hashing — an unusable verifier is a grant failure, not a
    // malformed request (RFC 6749 §5.2).
    if !is_valid_code_verifier_length(grant.code_verifier) {
        return Err(TokenError::bad_request(
            OAuthErrorCode::InvalidGrant,
            Some("Invalid code_verifier parameter"),
        ));
    }
    let parsed_redirect = Url::parse(grant.redirect_uri).map_err(|_| {
        TokenError::bad_request(
            OAuthErrorCode::InvalidRequest,
            Some("Invalid redirect_uri parameter"),
        )
    })?;
    // Atomically read-and-consume the code: a concurrent redemption of the
    // same code can only succeed once, so any racer past this point sees
    // `Ok(None)` and is rejected before a token is minted (RFC 6749 §10.5).
    let code_record = match state.store.redeem_authorization_code(grant.code)? {
        Some(record) => record,
        None => {
            // The code is gone — either already redeemed or never issued. If a
            // prior redemption minted a refresh-token family from this code,
            // the reuse is a theft signal (RFC 6749 §4.1.2 / OAuth 2.1
            // §4.1.2.1): revoke that lineage. A code that never existed, or one
            // whose grant carried no `offline_access`, matches no family and
            // this is a no-op.
            state
                .store
                .expire_refresh_token_families_for_authorization_code(
                    &token_storage_hash(grant.code),
                    Utc::now(),
                )?;
            // Consolidated under the generic `invalid_grant` response (C13);
            // log the specific reason for operator debuggability.
            tracing::warn!(
                "authorization_code grant rejected: code not found or already redeemed (possible replay)"
            );
            return Err(TokenError::bad_request(
                OAuthErrorCode::InvalidGrant,
                Some("Invalid authorization grant"),
            ));
        }
    };
    validate_code_and_issue_token(
        state,
        origin,
        &code_record,
        &presented_credentials.client_id,
        &parsed_redirect,
        grant.code_verifier,
    )
}

fn validate_code_and_issue_token(
    state: &GatekeeperState,
    origin: &str,
    code_record: &AuthorizationCode,
    client_id: &str,
    redirect_uri: &Url,
    code_verifier: &str,
) -> Result<TokenResponse, TokenError> {
    // RFC 6749 §5.2: code/redirect/client-binding and PKCE failures are all
    // `invalid_grant`. They share ONE generic description (C13) so the response
    // doesn't reveal which check failed — distinguishing "wrong client" from
    // "wrong redirect_uri" from "expired" from "bad PKCE verifier" would leak
    // facts about a code that may belong to another client. Each logs its
    // specific reason (no secrets — never the code, verifier, or challenge) so
    // the operator can still tell them apart.
    let invalid_grant = || {
        TokenError::bad_request(
            OAuthErrorCode::InvalidGrant,
            Some("Invalid authorization grant"),
        )
    };
    if code_record.client_id != client_id {
        tracing::warn!(
            code_client_id = %code_record.client_id,
            presented_client_id = %client_id,
            "authorization_code grant rejected: client_id does not match the code"
        );
        return Err(invalid_grant());
    }
    if code_record.redirect_uri != *redirect_uri {
        tracing::warn!(
            code_redirect_uri = %code_record.redirect_uri,
            presented_redirect_uri = %redirect_uri,
            "authorization_code grant rejected: redirect_uri does not match the code"
        );
        return Err(invalid_grant());
    }
    if code_record.expires_at < Utc::now() {
        tracing::warn!(
            expires_at = %code_record.expires_at,
            "authorization_code grant rejected: code expired"
        );
        return Err(invalid_grant());
    }
    let computed = compute_code_challenge(code_verifier);
    if !bool::from(
        code_record
            .code_challenge
            .as_bytes()
            .ct_eq(computed.as_bytes()),
    ) {
        tracing::warn!(
            client_id = %client_id,
            "authorization_code grant rejected: PKCE code_verifier does not match code_challenge"
        );
        return Err(invalid_grant());
    }
    // Resolve the standing authorization-code grant behind this exchange so the
    // family can record which grant authorized it (write-only in v1). Token
    // exchange already holds both keys; a missing grant (e.g. revoked between
    // approval and redemption) just leaves `grant_id` NULL.
    let grant_id = state
        .store
        .grant_by_client_and_redirect(client_id, redirect_uri)?
        .map(|grant| grant.id);
    let refresh_token = start_refresh_token_family_if_granted(
        state,
        client_id,
        &code_record.granted_scopes,
        code_record.patient.as_deref(),
        Some(code_record.code.as_str()),
        grant_id.as_deref(),
    )?;
    issue_token(
        state,
        &IssueTokenInput {
            client_id,
            granted_scopes: &code_record.granted_scopes,
            patient: code_record.patient.as_deref(),
            origin,
        },
        refresh_token,
    )
}
