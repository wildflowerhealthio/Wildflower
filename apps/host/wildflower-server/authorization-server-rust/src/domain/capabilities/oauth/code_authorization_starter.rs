//! [`CodeAuthorizationStarter`] — the `/oauth/authorize` flow (RFC 6749 §3.1,
//! §4.1.1; RFC 7636), for a browser that holds a browser session (the handler
//! sends one without a session to pairing first). Validates the request,
//! parks it, and either issues a
//! code on the spot under a
//! [`StandingGrantCoverage`](crate::domain::authority::StandingGrantCoverage)
//! proof (the one path that issues a code with no human in the loop — named as
//! an authority so it can be audited as such) or hands it to the Owner. A
//! SMART App Launch's `aud` is checked against this server, and its `launch`
//! is consumed and carried onto the parked request.
//!
//! A request asking for more than the browser's session holds (its **session
//! shortfall**: what a code issued in that session would not carry in full)
//! waits on that browser's limited page first, and goes on from there only
//! when the browser says to ([`CodeAuthorizationStarter::continue_past_session_shortfall`]).

use std::sync::Arc;

use chrono::{DateTime, Duration, Utc};
use url::Url;
use wildflowerhealthio_scopes::Grant;

use super::session_shortfall::load_unacknowledged_code_request;
use super::LaunchContexts;
use crate::crypto_util::pkce::is_valid_s256_code_challenge;
use crate::domain::authority::{
    session_shortfall, ApprovableScopes, GrantCoverage, StandingGrantCoverage,
};
use crate::domain::authorization_code::PendingCodeRequest;
use crate::domain::authorization_request::StartCodeAuthorizationArgs;
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::capabilities::writers::{CodeApproval, CodeAuthority, RequestApprover};
use crate::domain::client::Client;
use crate::domain::client_redirect::{
    BROWSER_SIGNED_OUT_DESCRIPTION, SCOPES_NOT_REGISTERED_DESCRIPTION,
};
use crate::domain::client_registration::{classify_registration, PresentedClientRegistration};
use crate::domain::launch_context::LaunchRefusal;
use crate::domain::oauth_error_code::OAuthErrorCode;
use crate::domain::oauth_error_kind::OAuthErrorKind;
use crate::domain::GrantStore;
use crate::ports::OwnerApproval;

/// Lifetime of a pending authorization request waiting for Owner approval.
pub(crate) const AUTHORIZATION_REQUEST_TTL: Duration = Duration::minutes(5);

/// The RFC 6749 §4.1.1 + RFC 7636 request, as presented, with the optional
/// SMART App Launch parameters.
pub(crate) struct AuthorizeRequest<'a> {
    pub(crate) response_type: &'a str,
    pub(crate) code_challenge_method: &'a str,
    pub(crate) client_id: &'a str,
    pub(crate) scope: &'a str,
    pub(crate) code_challenge: &'a str,
    pub(crate) redirect_uri: &'a str,
    pub(crate) client_state: &'a str,
    /// The SMART App Launch `launch` value the app was launched with, or
    /// `None` for a plain OAuth request.
    pub(crate) launch: Option<&'a str>,
    /// The SMART App Launch `aud`: the FHIR server the app means to call with
    /// the token, or `None` when the app doesn't declare one.
    pub(crate) aud: Option<&'a str>,
    /// The grant of the browser session the browser making the request
    /// holds. A code issued for the request carries only what it also allows,
    /// so a request asking for more waits on that browser's limited page
    /// first.
    pub(crate) browser_session_grant: &'a Grant,
    /// [`browser_session_grant`](Self::browser_session_grant), when that
    /// session can decide consents. The request can be
    /// decided in that browser when the grant also holds the request's
    /// approval scopes
    /// ([`ApprovableScopes::missing_approval_scopes`], as the consent card and
    /// the approval check them); that is recorded on a parked request.
    pub(crate) requesting_browser_grant: Option<&'a Grant>,
    /// Whether this start may raise a request for the Owner, asked once, only
    /// when the request is about to be: not decided in the requesting browser,
    /// and not issued on the standing-grant fast path. The authorization
    /// start limit, deferred to here for a browser that can decide consents
    /// so that the requests it decides itself spend nothing; `true` for a
    /// start the limit already admitted.
    pub(crate) may_raise_for_owner: &'a dyn Fn() -> bool,
    /// The browser session the browser making the request holds, recorded on
    /// the parked request and on the code it earns. A browser without one
    /// never gets this far: `/oauth/authorize` sends it to pairing.
    pub(crate) sid: &'a str,
}

/// The identifiers the flow mints; supplied by the caller so tests can inject
/// known values.
pub(crate) struct FreshIds {
    /// The parked request's id.
    pub(crate) request_id: String,
    /// The authorization code, used only on the fast path.
    pub(crate) code: String,
}

/// Where the user-agent goes next after `/authorize`.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum AuthorizeNextStep {
    /// Every requested scope was pre-approved: back to the client with a code
    /// (RFC 6749 §4.1.2).
    RedirectToClient {
        redirect_uri: Url,
        code: String,
        client_state: String,
    },
    /// The request is parked for the Owner: decided in the browser making it
    /// when `decidable_in_requesting_browser`, and otherwise raised for the
    /// Owner while the user-agent polls for the decision.
    AwaitOwner {
        request_id: String,
        decidable_in_requesting_browser: bool,
    },
    /// The browser's session holds less than the request asks for: the
    /// request is parked for that browser's limited page, which says so and
    /// goes on only when the browser does. Nothing is issued, spent or
    /// raised for the Owner yet.
    ConfirmSessionShortfall { request_id: String },
}

/// The ways starting an authorization can fail. `LocalPage` failures render
/// locally because the `redirect_uri` is not (yet) trusted; `Redirectable`
/// ones go back to the validated client redirect per RFC 6749 §4.1.2.1.
#[derive(Debug)]
pub(crate) enum AuthorizationStartError {
    /// No active signing key: the endpoint cannot issue codes, so it refuses up
    /// front rather than parking a request it can never complete.
    NoActiveSigningKey,
    /// A failure on a request whose `redirect_uri` is not trusted.
    LocalPage(OAuthErrorKind),
    /// A spec'd error once `redirect_uri` is validated, with the sentence the
    /// redirect carries as its `error_description`. The URL is boxed to keep
    /// the error small enough for `clippy::result_large_err`.
    Redirectable {
        redirect_uri: Box<Url>,
        error: OAuthErrorCode,
        description: &'static str,
        client_state: String,
    },
    /// The request this flow just parked was no longer pending when the fast
    /// path approved it — an unexpected concurrent transition.
    RequestNotPending,
    /// The request would be raised for the Owner, and
    /// [`may_raise_for_owner`](AuthorizeRequest::may_raise_for_owner) refused:
    /// the authorization start limit. Nothing is parked.
    StartLimited,
    Store(AuthorizationServerError),
}

impl From<AuthorizationServerError> for AuthorizationStartError {
    fn from(error: AuthorizationServerError) -> Self {
        AuthorizationStartError::Store(error)
    }
}

/// Start authorization-code flows. Public (no principal: the caller is the
/// user's browser), so its only power is this one operation. Generic over the
/// store port so it's unit-testable against the fake; the binding instantiates
/// it over the concrete `SqliteGrantStore`.
pub(crate) struct CodeAuthorizationStarter<S: GrantStore> {
    store: S,
    owner_approval: Arc<dyn OwnerApproval>,
    wildflower_host_app_client_id: Arc<str>,
    /// The server's bare origin, `https://<domain>`, also its FHIR base: an
    /// `aud` must name it.
    server_origin: Arc<str>,
}

impl<S: GrantStore> CodeAuthorizationStarter<S> {
    /// Build the starter over the store, the popup republish port, the
    /// host app's `client_id`, and the server's origin — all lifted from the
    /// state.
    pub(crate) fn new(
        store: S,
        owner_approval: Arc<dyn OwnerApproval>,
        wildflower_host_app_client_id: Arc<str>,
        server_origin: Arc<str>,
    ) -> Self {
        CodeAuthorizationStarter {
            store,
            owner_approval,
            wildflower_host_app_client_id,
            server_origin,
        }
    }

    /// Validate `authorize_query` (client and redirect first, then the redirectable
    /// params), park it, and decide: a fully pre-approved request is issued a
    /// code under the standing grant's authority and sent back to the client;
    /// anything else waits on the Owner as a pending consent.
    ///
    /// Clients other than the host app's are trusted on first use (see
    /// [`crate::domain::client_registration`]): a request outside the
    /// registration is parked with a warning rather than rejected, never takes
    /// the fast path, and — while its redirect is untrusted — renders every
    /// failure locally rather than risk an open redirect.
    ///
    /// A declared `aud` must be this server's origin (its FHIR base). A
    /// `launch` must name an unconsumed, unexpired launch context minted for
    /// this client or for any client; it is consumed (so it never works twice)
    /// and carried onto the parked request. Either failure is
    /// `invalid_request`, and its description says why: a client sees its own
    /// launch's state (not recognized, already used, expired), and another
    /// app's launch looks unknown. A request with no `launch` is plain
    /// OAuth. When the launch binds a patient, the fast path applies only if
    /// the standing grant names the same one; otherwise the Owner decides.
    ///
    /// A request whose browser session holds less than it asks for (see
    /// [`session_shortfall`]) is parked, once validated and its launch
    /// consumed, for its browser's limited page
    /// ([`AuthorizeNextStep::ConfirmSessionShortfall`]); the fast path, the
    /// start limit and the Owner wait for
    /// [`continue_past_session_shortfall`](Self::continue_past_session_shortfall).
    ///
    /// # Errors
    ///
    /// See [`AuthorizationStartError`].
    pub(crate) fn start(
        &self,
        authorize_query: &AuthorizeRequest<'_>,
        ids: FreshIds,
        now: DateTime<Utc>,
    ) -> Result<AuthorizeNextStep, AuthorizationStartError> {
        if !self.store.has_active_signing_key()? {
            return Err(AuthorizationStartError::NoActiveSigningKey);
        }
        let registration_is_fixed = self.registration_is_fixed(authorize_query.client_id);
        let maybe_existing_client =
            self.load_client(authorize_query.client_id, registration_is_fixed)?;
        let requested_redirect_uri = parse_redirect_uri(authorize_query.redirect_uri)?;
        // A redirect is trustworthy only when a client we already know already
        // registered it.
        let redirect_allowlisted = maybe_existing_client
            .as_ref()
            .is_some_and(|existing_client| {
                existing_client.allows_redirect_uri(&requested_redirect_uri)
            });
        if registration_is_fixed && !redirect_allowlisted {
            return Err(AuthorizationStartError::LocalPage(
                OAuthErrorKind::RedirectUriNotAllowed,
            ));
        }
        validate_code_params(
            authorize_query,
            &requested_redirect_uri,
            redirect_allowlisted,
            &self.server_origin,
        )?;
        let requested_scopes: Vec<String> = authorize_query
            .scope
            .split_whitespace()
            .map(str::to_string)
            .collect();
        if let (true, Some(fixed_client)) = (registration_is_fixed, maybe_existing_client.as_ref())
        {
            if !fixed_client.allows_scopes(&requested_scopes) {
                return Err(AuthorizationStartError::Redirectable {
                    redirect_uri: Box::new(requested_redirect_uri),
                    error: OAuthErrorCode::InvalidScope,
                    description: SCOPES_NOT_REGISTERED_DESCRIPTION,
                    client_state: authorize_query.client_state.to_owned(),
                });
            }
        }
        let registration_verdict = classify_registration(&PresentedClientRegistration {
            maybe_existing_client: maybe_existing_client.as_ref(),
            redirect_uri: &requested_redirect_uri,
            scopes: &requested_scopes,
        });
        let approvable = ApprovableScopes::for_code(
            &requested_scopes,
            maybe_existing_client.as_ref(),
            registration_is_fixed,
        );
        let decidable_in_requesting_browser =
            authorize_query
                .requesting_browser_grant
                .is_some_and(|requesting_browser_grant| {
                    approvable
                        .missing_approval_scopes(requesting_browser_grant)
                        .is_empty()
                });
        let coverage = GrantCoverage::resolve(
            &self.store,
            &registration_verdict,
            authorize_query.client_id,
            &requested_redirect_uri,
            &requested_scopes,
        )?;

        // Consume the launch last, after every check that can refuse the
        // request, so a refused request leaves its launch unspent.
        let launch_context = match authorize_query.launch {
            None => None,
            Some(launch) => {
                match LaunchContexts::over(&self.store).consume(
                    launch,
                    authorize_query.client_id,
                    now,
                )? {
                    Ok(launch_context) => Some(launch_context),
                    Err(launch_refusal) => {
                        tracing::warn!(
                            client_id = authorize_query.client_id,
                            ?launch_refusal,
                            "refused a launch",
                        );
                        return Err(start_error(
                            authorize_query,
                            &requested_redirect_uri,
                            redirect_allowlisted,
                            OAuthErrorCode::InvalidRequest,
                            launch_refusal_kind(launch_refusal),
                        ));
                    }
                }
            }
        };

        let has_session_shortfall =
            !session_shortfall(&requested_scopes, authorize_query.browser_session_grant).is_empty();
        let parked_request =
            PendingCodeRequest::new_code_authorization(StartCodeAuthorizationArgs {
                id: ids.request_id.clone(),
                client_id: authorize_query.client_id.to_owned(),
                requested_scopes,
                code_challenge: authorize_query.code_challenge.to_owned(),
                redirect_uri: requested_redirect_uri,
                client_state: authorize_query.client_state.to_owned(),
                pre_approved_scopes: coverage.pre_approved_scopes().to_vec(),
                ttl: AUTHORIZATION_REQUEST_TTL,
                launch_context,
                decidable_in_requesting_browser,
                sid: authorize_query.sid.to_owned(),
                session_shortfall_acknowledged: !has_session_shortfall,
            });
        // The session falls short: park the request for its browser's limited
        // page (the launch is spent by then, as by any later refusal). The
        // Owner isn't told of it, so nothing is republished.
        if has_session_shortfall {
            self.store
                .insert_authorization_request(parked_request.request())?;
            return Ok(AuthorizeNextStep::ConfirmSessionShortfall {
                request_id: ids.request_id,
            });
        }
        self.decide(
            &parked_request,
            coverage,
            authorize_query.may_raise_for_owner,
            ids.code,
            now,
            // Park the request — every path from here on references it by id.
            || {
                Ok(self
                    .store
                    .insert_authorization_request(parked_request.request())?)
            },
        )
    }

    /// Go on with request `id`, which waits on the limited page of the
    /// browser holding the browser session `sid`: acknowledge its session
    /// shortfall and take the branch [`start`](Self::start) would have taken
    /// had the session held all it asks for. Its standing-grant coverage is
    /// read again (the Owner may have approved or revoked a grant meanwhile),
    /// so a covered request is issued `code` under it, and any other is raised
    /// for the Owner once `may_raise_for_owner` admits it, and decided on the
    /// consent card or the wait page as recorded at its start.
    ///
    /// # Errors
    ///
    /// [`AuthorizationStartError::Store`] with
    /// [`AuthorizationServerError::AuthorizationRequestNotFound`] for a
    /// request no longer waiting on that page (another session's, already
    /// acknowledged, decided, or expired: the same as an expired request
    /// anywhere else); [`AuthorizationStartError::StartLimited`], leaving the
    /// request waiting; [`AuthorizationStartError::LocalPage`] for a client
    /// disabled since; otherwise as [`start`](Self::start).
    pub(crate) fn continue_past_session_shortfall(
        &self,
        id: &str,
        sid: &str,
        may_raise_for_owner: &dyn Fn() -> bool,
        code: String,
        now: DateTime<Utc>,
    ) -> Result<AuthorizeNextStep, AuthorizationStartError> {
        let parked_request = load_unacknowledged_code_request(&self.store, id, sid, now)?;
        let request = parked_request.request();
        let registration_is_fixed = self.registration_is_fixed(&request.client_id);
        let maybe_existing_client = self.load_client(&request.client_id, registration_is_fixed)?;
        let registration_verdict = classify_registration(&PresentedClientRegistration {
            maybe_existing_client: maybe_existing_client.as_ref(),
            redirect_uri: parked_request.redirect_uri(),
            scopes: &request.requested_scopes,
        });
        let coverage = GrantCoverage::resolve(
            &self.store,
            &registration_verdict,
            &request.client_id,
            parked_request.redirect_uri(),
            &request.requested_scopes,
        )?;
        self.decide(
            &parked_request,
            coverage,
            may_raise_for_owner,
            code,
            now,
            || {
                if self.store.acknowledge_session_shortfall(id)? {
                    Ok(())
                } else {
                    Err(AuthorizationStartError::Store(
                        AuthorizationServerError::AuthorizationRequestNotFound {
                            id: id.to_owned(),
                        },
                    ))
                }
            },
        )
    }

    /// The shared tail of [`start`](Self::start) and
    /// [`continue_past_session_shortfall`](Self::continue_past_session_shortfall),
    /// for `parked_request`, whose session holds all it asks for or whose
    /// browser has said to go on: ask the start limit when the request is
    /// about to be raised for the Owner, then `park` it (insert it, or mark
    /// its shortfall acknowledged), then issue `code` under the standing
    /// grant when `coverage` is full and admits the launch's patient, or else
    /// raise it for the Owner.
    fn decide(
        &self,
        parked_request: &PendingCodeRequest,
        coverage: GrantCoverage,
        may_raise_for_owner: &dyn Fn() -> bool,
        code: String,
        now: DateTime<Utc>,
        park: impl FnOnce() -> Result<(), AuthorizationStartError>,
    ) -> Result<AuthorizeNextStep, AuthorizationStartError> {
        let request = parked_request.request();
        let decidable_in_requesting_browser = request.decidable_in_requesting_browser;
        // The fast path: the standing grant is the authority, as long as its
        // patient is one the launch admits.
        let fast_path_coverage = match coverage {
            GrantCoverage::Full(standing_grant_coverage)
                if request.admits_patient(standing_grant_coverage.patient()) =>
            {
                Some(standing_grant_coverage)
            }
            _ => None,
        };
        // A request about to be raised for the Owner asks the start limit
        // first (the launch is spent by then, as by any later refusal).
        if fast_path_coverage.is_none()
            && !decidable_in_requesting_browser
            && !may_raise_for_owner()
        {
            return Err(AuthorizationStartError::StartLimited);
        }

        park()?;

        if let Some(standing_grant_coverage) = fast_path_coverage {
            // Parking left this request pending for the width of the
            // approval, so the popup head is recomputed afterwards rather
            // than left on a request the consent surface now 404s for;
            // recomputing can only publish the genuinely-pending head, never
            // this one.
            return self.issue_under_standing_grant(
                &standing_grant_coverage,
                parked_request,
                code,
                now,
            );
        }

        // This request needs a human: raise the host popup (after the fast-path
        // return above, so a pre-approved request never flickers into it).
        self.owner_approval.republish_active();
        Ok(AuthorizeNextStep::AwaitOwner {
            request_id: request.id.clone(),
            decidable_in_requesting_browser,
        })
    }

    /// The fast path's approval: issue `code` for `parked_request` under the
    /// standing grant, recompute the popup head, and send the user-agent back
    /// to the client with the code, or with `access_denied` when the browser
    /// session the request was made in ended meanwhile.
    fn issue_under_standing_grant(
        &self,
        standing_grant_coverage: &StandingGrantCoverage,
        parked_request: &PendingCodeRequest,
        code: String,
        now: DateTime<Utc>,
    ) -> Result<AuthorizeNextStep, AuthorizationStartError> {
        let requested_redirect_uri = parked_request.redirect_uri().clone();
        let client_state = parked_request
            .request()
            .client_state
            .as_deref()
            .unwrap_or_default();
        let code_approval = RequestApprover::over(&self.store).approve_for_code(
            CodeAuthority::StandingGrant(standing_grant_coverage),
            parked_request,
            standing_grant_coverage.patient(),
            code,
            now,
        )?;
        self.owner_approval.republish_active();
        match code_approval {
            CodeApproval::Issued(issued_code) => Ok(AuthorizeNextStep::RedirectToClient {
                redirect_uri: requested_redirect_uri,
                code: issued_code.code,
                client_state: client_state.to_owned(),
            }),
            CodeApproval::RequestNotPending => Err(AuthorizationStartError::RequestNotPending),
            CodeApproval::BrowserSessionEnded => Err(AuthorizationStartError::Redirectable {
                redirect_uri: Box::new(requested_redirect_uri),
                error: OAuthErrorCode::AccessDenied,
                description: BROWSER_SIGNED_OUT_DESCRIPTION,
                client_state: client_state.to_owned(),
            }),
        }
    }

    /// Whether `client_id`'s registration is fixed — defined by the server
    /// rather than trusted on first use: true only for the host app's client,
    /// the one client held to its registration.
    fn registration_is_fixed(&self, client_id: &str) -> bool {
        client_id == &*self.wildflower_host_app_client_id
    }

    /// The client row named by the request, if any. A disabled client is
    /// rejected outright, as is the host app's `client_id` with no row; any other
    /// unknown `client_id` is `None` — a `New` registration verdict.
    fn load_client(
        &self,
        client_id: &str,
        registration_is_fixed: bool,
    ) -> Result<Option<Client>, AuthorizationStartError> {
        let Some(client) = self.store.client_by_id(client_id)? else {
            return if registration_is_fixed {
                Err(AuthorizationStartError::LocalPage(
                    OAuthErrorKind::UnknownClient,
                ))
            } else {
                Ok(None)
            };
        };
        if client.disabled_at.is_some() {
            return Err(AuthorizationStartError::LocalPage(
                OAuthErrorKind::DisabledClient,
            ));
        }
        Ok(Some(client))
    }
}

/// The presented `redirect_uri` must be a well-formed http/https URL (RFC 6749
/// §4.1.2.1); either failure is an unconditional local page.
fn parse_redirect_uri(redirect_uri: &str) -> Result<Url, AuthorizationStartError> {
    let parsed = Url::parse(redirect_uri)
        .map_err(|_| AuthorizationStartError::LocalPage(OAuthErrorKind::InvalidRedirectUri))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(AuthorizationStartError::LocalPage(
            OAuthErrorKind::InvalidScheme,
        ));
    }
    Ok(parsed)
}

/// The response type, the PKCE challenge, and a declared `aud` — spec'd errors
/// delivered back to the client only once the redirect is trusted, else as a
/// local page.
fn validate_code_params(
    authorize_query: &AuthorizeRequest<'_>,
    redirect_uri: &Url,
    redirect_trusted: bool,
    server_origin: &str,
) -> Result<(), AuthorizationStartError> {
    let fail = |error: OAuthErrorCode, local: OAuthErrorKind| {
        start_error(
            authorize_query,
            redirect_uri,
            redirect_trusted,
            error,
            local,
        )
    };
    // Only the authorization-code grant is implemented (RFC 6749 §4.1.2.1).
    if authorize_query.response_type != "code" {
        return Err(fail(
            OAuthErrorCode::UnsupportedResponseType,
            OAuthErrorKind::UnsupportedResponseType,
        ));
    }
    // Only S256 PKCE is supported; anything else is `invalid_request` (RFC
    // 7636 §4.4.1), as is a malformed challenge.
    if authorize_query.code_challenge_method != "S256" {
        return Err(fail(
            OAuthErrorCode::InvalidRequest,
            OAuthErrorKind::UnsupportedCodeChallengeMethod,
        ));
    }
    if !is_valid_s256_code_challenge(authorize_query.code_challenge) {
        return Err(fail(
            OAuthErrorCode::InvalidRequest,
            OAuthErrorKind::InvalidCodeChallenge,
        ));
    }
    // A declared SMART `aud` must name this server.
    if let Some(aud) = authorize_query.aud {
        // The server's origin is also its FHIR base, the `iss` every launch
        // hands the app, so a SMART `aud` names this server exactly when it is
        // that origin.
        if aud != server_origin {
            return Err(fail(
                OAuthErrorCode::InvalidRequest,
                OAuthErrorKind::InvalidAudience,
            ));
        }
    }
    Ok(())
}

/// The reason a client is told for `launch_refusal`. Another app's launch
/// reads exactly like one that doesn't exist, so a client learns nothing about
/// it; only the server's own log tells the two apart.
fn launch_refusal_kind(launch_refusal: LaunchRefusal) -> OAuthErrorKind {
    match launch_refusal {
        LaunchRefusal::Unknown | LaunchRefusal::ForAnotherApp => OAuthErrorKind::LaunchUnknown,
        LaunchRefusal::AlreadyUsed => OAuthErrorKind::LaunchAlreadyUsed,
        LaunchRefusal::Expired => OAuthErrorKind::LaunchExpired,
    }
}

/// A refusal of `authorize_query`: back to the client as `error`, with the
/// `local` kind's sentence as its `error_description`, once its redirect is
/// trusted; else the `local` page (RFC 6749 §4.1.2.1).
fn start_error(
    authorize_query: &AuthorizeRequest<'_>,
    redirect_uri: &Url,
    redirect_trusted: bool,
    error: OAuthErrorCode,
    local: OAuthErrorKind,
) -> AuthorizationStartError {
    if redirect_trusted {
        AuthorizationStartError::Redirectable {
            redirect_uri: Box::new(redirect_uri.clone()),
            error,
            description: local.description(),
            client_state: authorize_query.client_state.to_owned(),
        }
    } else {
        AuthorizationStartError::LocalPage(local)
    }
}

#[cfg(test)]
mod tests {

    use super::*;
    use crate::domain::authorization_request::RequestStatus;
    use crate::domain::browser_session::BrowserSession;
    use crate::domain::client::ClientKind;
    use crate::domain::grant::AuthorizationCodeGrant;
    use crate::domain::launch_context::{LaunchContext, LAUNCH_CONTEXT_TTL};
    use crate::domain::GrantTx as _;

    use crate::domain::test_fake::{
        client, code_grant, seed_active_signing_key, FakeGrantStore, RecordingOwnerApproval,
    };

    const CHALLENGE: &str = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    const SERVER_ORIGIN: &str = "https://ruth.relay.example";
    /// The browser session every request here is made in, standing in the
    /// starter's store.
    const REQUESTING_SID: &str = "requesting-sid";

    /// The grant of a browser session that holds all the Owner holds, so it
    /// falls short of no request.
    static OWNER_SESSION_GRANT: std::sync::LazyLock<Grant> =
        std::sync::LazyLock::new(|| Grant::parse(crate::owner_scopes()));

    fn request<'a>(client_id: &'a str, scope: &'a str) -> AuthorizeRequest<'a> {
        AuthorizeRequest {
            response_type: "code",
            code_challenge_method: "S256",
            client_id,
            scope,
            code_challenge: CHALLENGE,
            redirect_uri: "https://example.com/cb",
            client_state: "xyz",
            launch: None,
            aud: None,
            browser_session_grant: &OWNER_SESSION_GRANT,
            requesting_browser_grant: None,
            may_raise_for_owner: &|| true,
            sid: REQUESTING_SID,
        }
    }

    fn ids() -> FreshIds {
        FreshIds {
            request_id: "req-1".to_owned(),
            code: "the-code".to_owned(),
        }
    }

    fn starter(
        store: FakeGrantStore,
    ) -> (
        CodeAuthorizationStarter<FakeGrantStore>,
        Arc<RecordingOwnerApproval>,
    ) {
        seed_active_signing_key(&store);
        store
            .insert_browser_session(&BrowserSession {
                sid: REQUESTING_SID.to_owned(),
                ..BrowserSession::new_approved(
                    "Firefox on Linux".to_owned(),
                    vec!["wildflower/launch".to_owned()],
                    Duration::hours(24),
                    Utc::now(),
                )
            })
            .unwrap();
        let owner_approval = Arc::new(RecordingOwnerApproval::default());
        let code_authorization_starter = CodeAuthorizationStarter::new(
            store,
            owner_approval.clone(),
            "host".into(),
            SERVER_ORIGIN.into(),
        );
        (code_authorization_starter, owner_approval)
    }

    /// A registered client with a standing grant covering every requested
    /// scope takes the fast path: the request is parked and approved, a code
    /// is issued under the grant's authority (with its patient) and the
    /// requesting browser's session, and the popup head is recomputed.
    #[test]
    fn a_fully_covered_registered_request_is_issued_a_code_without_a_human() {
        let store = FakeGrantStore::default();
        store
            .upsert_client(&client("app", &["patient/Patient.r", "openid"]))
            .unwrap();
        store
            .create_authorization_code_grant(&AuthorizationCodeGrant {
                scopes: vec!["patient/*.cruds".to_owned(), "openid".to_owned()],
                patient: Some("pat-1".to_owned()),
                ..code_grant("g1", "app")
            })
            .unwrap();
        let (code_authorization_starter, owner_approval) = starter(store);
        let outcome = code_authorization_starter
            .start(
                &request("app", "patient/Patient.r openid"),
                ids(),
                Utc::now(),
            )
            .expect("starts");
        assert_eq!(
            outcome,
            AuthorizeNextStep::RedirectToClient {
                redirect_uri: Url::parse("https://example.com/cb").unwrap(),
                code: "the-code".to_owned(),
                client_state: "xyz".to_owned(),
            }
        );
        let parked_request = code_authorization_starter
            .store
            .authorization_request_by_id("req-1")
            .unwrap()
            .expect("parked_request");
        assert_eq!(parked_request.status, RequestStatus::Approved);
        assert_eq!(parked_request.patient.as_deref(), Some("pat-1"));
        assert_eq!(parked_request.sid.as_deref(), Some(REQUESTING_SID));
        assert_eq!(
            code_authorization_starter
                .store
                .authorization_code_by_request_id("req-1")
                .unwrap()
                .expect("the code")
                .sid,
            REQUESTING_SID,
            "the code is issued under the requesting browser's session"
        );
        assert_eq!(owner_approval.count(), 1);
    }

    /// On the fast path, a request made in a browser session that no longer
    /// stands is denied and sent back to the client with `access_denied`
    /// rather than a code whose tokens would be refused.
    #[test]
    fn the_fast_path_denies_a_request_whose_browser_session_is_revoked() {
        let store = FakeGrantStore::default();
        store
            .upsert_client(&client("app", &["patient/Patient.r"]))
            .unwrap();
        store
            .create_authorization_code_grant(&AuthorizationCodeGrant {
                scopes: vec!["patient/*.cruds".to_owned()],
                ..code_grant("g1", "app")
            })
            .unwrap();
        let (code_authorization_starter, owner_approval) = starter(store);
        let outcome = code_authorization_starter.start(
            &AuthorizeRequest {
                sid: "no-such-sid",
                ..request("app", "patient/Patient.r")
            },
            ids(),
            Utc::now(),
        );
        assert!(matches!(
            outcome,
            Err(AuthorizationStartError::Redirectable {
                error: OAuthErrorCode::AccessDenied,
                description: BROWSER_SIGNED_OUT_DESCRIPTION,
                ..
            })
        ));
        let parked_request = code_authorization_starter
            .store
            .authorization_request_by_id("req-1")
            .unwrap()
            .expect("parked_request");
        assert_eq!(parked_request.status, RequestStatus::Denied);
        assert_eq!(
            code_authorization_starter
                .store
                .authorization_code_by_request_id("req-1")
                .unwrap(),
            None
        );
        assert_eq!(owner_approval.count(), 1);
    }

    /// A request outside the registration (a scope the client never
    /// registered) waits for the Owner even though the standing grant would
    /// cover it — the Owner has not seen this combination.
    #[test]
    fn a_request_outside_the_registration_waits_for_the_owner() {
        let store = FakeGrantStore::default();
        store.upsert_client(&client("app", &["openid"])).unwrap();
        store
            .create_authorization_code_grant(&AuthorizationCodeGrant {
                scopes: vec!["patient/*.cruds".to_owned(), "openid".to_owned()],
                ..code_grant("g1", "app")
            })
            .unwrap();
        let (code_authorization_starter, owner_approval) = starter(store);
        let outcome = code_authorization_starter
            .start(
                &request("app", "patient/Patient.r openid"),
                ids(),
                Utc::now(),
            )
            .expect("starts");
        assert_eq!(
            outcome,
            AuthorizeNextStep::AwaitOwner {
                request_id: "req-1".to_owned(),
                decidable_in_requesting_browser: false,
            }
        );
        let parked_request = code_authorization_starter
            .store
            .authorization_request_by_id("req-1")
            .unwrap()
            .expect("parked_request");
        assert_eq!(parked_request.status, RequestStatus::Pending);
        assert!(parked_request.pre_approved_scopes.is_empty());
        assert_eq!(owner_approval.count(), 1);
    }

    /// Trust on first use: an unknown client other than the host app's is parked_request for the
    /// Owner, and its later failures render locally (the redirect is
    /// unvouched-for), while the host app's client with an unregistered
    /// redirect is refused outright.
    #[test]
    fn unknown_clients_park_and_untrusted_redirects_fail_locally() {
        let (code_authorization_starter, _) = starter(FakeGrantStore::default());
        let outcome = code_authorization_starter
            .start(&request("newcomer", "openid"), ids(), Utc::now())
            .expect("parked_request for the owner");
        assert!(matches!(outcome, AuthorizeNextStep::AwaitOwner { .. }));

        let mut bad_type = request("newcomer", "openid");
        bad_type.response_type = "token";
        assert!(matches!(
            code_authorization_starter.start(&bad_type, ids(), Utc::now()),
            Err(AuthorizationStartError::LocalPage(
                OAuthErrorKind::UnsupportedResponseType
            ))
        ));

        assert!(matches!(
            code_authorization_starter.start(&request("host", "openid"), ids(), Utc::now()),
            Err(AuthorizationStartError::LocalPage(
                OAuthErrorKind::UnknownClient
            ))
        ));
    }

    /// Once the redirect is trusted, a spec'd failure goes back to the client,
    /// and the host app's client is held to its scope allowlist.
    #[test]
    fn trusted_redirects_get_redirectable_errors_and_the_host_is_clamped() {
        let store = FakeGrantStore::default();
        store
            .upsert_client(&Client {
                kind: ClientKind::Public,
                redirect_uris: vec![Url::parse("https://example.com/cb").unwrap()],
                ..client("host", &["openid"])
            })
            .unwrap();
        let (code_authorization_starter, _) = starter(store);
        let mut bad_type = request("host", "openid");
        bad_type.response_type = "token";
        assert!(matches!(
            code_authorization_starter.start(&bad_type, ids(), Utc::now()),
            Err(AuthorizationStartError::Redirectable {
                error: OAuthErrorCode::UnsupportedResponseType,
                ..
            })
        ));
        assert!(matches!(
            code_authorization_starter.start(
                &request("host", "openid patient/Patient.r"),
                ids(),
                Utc::now()
            ),
            Err(AuthorizationStartError::Redirectable {
                error: OAuthErrorCode::InvalidScope,
                description: SCOPES_NOT_REGISTERED_DESCRIPTION,
                ..
            })
        ));
    }

    /// Without a signing key nothing is parked_request: the endpoint refuses up front.
    #[test]
    fn no_signing_key_refuses_before_parking() {
        let store = FakeGrantStore::default();
        let code_authorization_starter = CodeAuthorizationStarter::new(
            store,
            Arc::new(RecordingOwnerApproval::default()),
            "host".into(),
            SERVER_ORIGIN.into(),
        );
        assert!(matches!(
            code_authorization_starter.start(&request("app", "openid"), ids(), Utc::now()),
            Err(AuthorizationStartError::NoActiveSigningKey)
        ));
        assert!(code_authorization_starter
            .store
            .authorization_request_by_id("req-1")
            .unwrap()
            .is_none());
    }

    /// The starter's store, for planting and reading launch contexts.
    fn launch_contexts_of(
        code_authorization_starter: &CodeAuthorizationStarter<FakeGrantStore>,
    ) -> LaunchContexts<'_, FakeGrantStore> {
        LaunchContexts::over(&code_authorization_starter.store)
    }

    /// A registered client "app" with no standing grant, so every valid
    /// request parks for the Owner.
    fn registered_app_starter() -> CodeAuthorizationStarter<FakeGrantStore> {
        let store = FakeGrantStore::default();
        store.upsert_client(&client("app", &["openid"])).unwrap();
        starter(store).0
    }

    /// A declared `aud` is accepted when it is exactly this server's origin
    /// (also its FHIR base), and refused as `invalid_request` otherwise — back to a
    /// trusted redirect, or as the local page while the redirect is untrusted.
    #[test]
    fn aud_must_name_this_server() {
        let code_authorization_starter = registered_app_starter();
        let authorize_query = AuthorizeRequest {
            aud: Some("https://ruth.relay.example"),
            ..request("app", "openid")
        };
        assert!(
            matches!(
                code_authorization_starter.start(&authorize_query, ids(), Utc::now()),
                Ok(AuthorizeNextStep::AwaitOwner { .. })
            ),
            "the origin is this server",
        );
        for refused in [
            "https://ruth.relay.example/",
            "https://ruth.relay.example/fhir-r4",
            "https://ruth.relay.example.evil",
            "http://ruth.relay.example",
            "https://other.relay.example",
            "",
        ] {
            let authorize_query = AuthorizeRequest {
                aud: Some(refused),
                ..request("app", "openid")
            };
            assert!(
                matches!(
                    code_authorization_starter.start(&authorize_query, ids(), Utc::now()),
                    Err(AuthorizationStartError::Redirectable {
                        error: OAuthErrorCode::InvalidRequest,
                        ..
                    })
                ),
                "{refused:?} is not this server",
            );
            let untrusted_query = AuthorizeRequest {
                aud: Some(refused),
                ..request("newcomer", "openid")
            };
            assert!(matches!(
                code_authorization_starter.start(&untrusted_query, ids(), Utc::now()),
                Err(AuthorizationStartError::LocalPage(
                    OAuthErrorKind::InvalidAudience
                ))
            ));
        }
    }

    /// A valid `launch` is consumed and its context carried onto the parked
    /// request; presenting it again renders the local page that asks for a
    /// new launch, and parks nothing.
    #[test]
    fn a_launch_is_consumed_onto_the_parked_request_once() {
        let code_authorization_starter = registered_app_starter();
        let now = Utc::now();
        launch_contexts_of(&code_authorization_starter)
            .mint("app", "launch-1".to_owned(), now)
            .unwrap();
        let authorize_query = AuthorizeRequest {
            launch: Some("launch-1"),
            ..request("app", "openid")
        };
        assert!(matches!(
            code_authorization_starter.start(&authorize_query, ids(), now),
            Ok(AuthorizeNextStep::AwaitOwner { .. })
        ));
        let parked_request = code_authorization_starter
            .store
            .authorization_request_by_id("req-1")
            .unwrap()
            .expect("parked");
        assert_eq!(parked_request.launch.as_deref(), Some("launch-1"));
        assert_eq!(parked_request.launch_bound_patient, None);

        let replay = FreshIds {
            request_id: "req-2".to_owned(),
            code: "another-code".to_owned(),
        };
        assert!(matches!(
            code_authorization_starter.start(&authorize_query, replay, now),
            Err(AuthorizationStartError::Redirectable {
                error: OAuthErrorCode::InvalidRequest,
                description: "This launch was already used. Open the app again.",
                ..
            })
        ));
        assert!(
            code_authorization_starter
                .store
                .authorization_request_by_id("req-2")
                .unwrap()
                .is_none(),
            "a replayed launch parks nothing"
        );
    }

    /// The `invalid_request` for a launch `launch` presented by "app" at
    /// `now`, back to its trusted redirect: the description it carries, or
    /// `None` when the request was not refused that way.
    fn launch_refusal_description(
        code_authorization_starter: &CodeAuthorizationStarter<FakeGrantStore>,
        launch: &str,
        now: DateTime<Utc>,
    ) -> Option<&'static str> {
        let authorize_query = AuthorizeRequest {
            launch: Some(launch),
            ..request("app", "openid")
        };
        match code_authorization_starter.start(&authorize_query, ids(), now) {
            Err(AuthorizationStartError::Redirectable {
                error: OAuthErrorCode::InvalidRequest,
                description,
                ..
            }) => Some(description),
            _ => None,
        }
    }

    /// The local page for a launch `launch` presented at `now` by a client
    /// whose redirect is untrusted, or `None` when it is not a local page.
    fn launch_refusal_page(
        code_authorization_starter: &CodeAuthorizationStarter<FakeGrantStore>,
        launch: &str,
        now: DateTime<Utc>,
    ) -> Option<OAuthErrorKind> {
        let untrusted_query = AuthorizeRequest {
            launch: Some(launch),
            ..request("newcomer", "openid")
        };
        match code_authorization_starter.start(&untrusted_query, ids(), now) {
            Err(AuthorizationStartError::LocalPage(kind)) => Some(kind),
            _ => None,
        }
    }

    /// A launch minted for another client and a forged one are both "not
    /// recognized", so the two can't be told apart; the other client's launch
    /// is left for its own client to consume. No `launch` at all is plain
    /// OAuth.
    #[test]
    fn a_launch_for_another_client_reads_like_a_forged_one() {
        let code_authorization_starter = registered_app_starter();
        let now = Utc::now();
        let launch_contexts = launch_contexts_of(&code_authorization_starter);
        launch_contexts
            .mint("other-app", "for-other-app".to_owned(), now)
            .unwrap();
        for launch in ["for-other-app", "forged"] {
            assert_eq!(
                launch_refusal_description(&code_authorization_starter, launch, now),
                Some(OAuthErrorKind::LaunchUnknown.description()),
                "{launch} is refused",
            );
            assert_eq!(
                launch_refusal_page(&code_authorization_starter, launch, now),
                Some(OAuthErrorKind::LaunchUnknown),
            );
        }
        assert!(
            launch_contexts
                .consume("for-other-app", "other-app", now)
                .unwrap()
                .is_ok(),
            "a mismatched client doesn't spend the launch"
        );
        assert!(matches!(
            code_authorization_starter.start(&request("app", "openid"), ids(), now),
            Ok(AuthorizeNextStep::AwaitOwner { .. })
        ));
    }

    /// A launch presented once its TTL has run out is refused as expired,
    /// back to a trusted redirect or as the local page.
    #[test]
    fn an_expired_launch_is_refused_as_expired() {
        let code_authorization_starter = registered_app_starter();
        let minted_at = Utc::now();
        launch_contexts_of(&code_authorization_starter)
            .mint("app", "launch-1".to_owned(), minted_at)
            .unwrap();
        let past_the_ttl = minted_at + LAUNCH_CONTEXT_TTL;
        assert_eq!(
            launch_refusal_description(&code_authorization_starter, "launch-1", past_the_ttl),
            Some("This launch has expired. Open the app again."),
        );

        launch_contexts_of(&code_authorization_starter)
            .mint_for_any_client("launch-2".to_owned(), minted_at)
            .unwrap();
        assert_eq!(
            launch_refusal_page(&code_authorization_starter, "launch-2", past_the_ttl),
            Some(OAuthErrorKind::LaunchExpired),
        );
    }

    /// A launch presented a second time is refused as already used, back to a
    /// trusted redirect or as the local page.
    #[test]
    fn a_consumed_launch_is_refused_as_already_used() {
        let code_authorization_starter = registered_app_starter();
        let now = Utc::now();
        let launch_contexts = launch_contexts_of(&code_authorization_starter);
        launch_contexts
            .mint("app", "launch-1".to_owned(), now)
            .unwrap();
        launch_contexts
            .mint_for_any_client("launch-2".to_owned(), now)
            .unwrap();
        for launch in ["launch-1", "launch-2"] {
            launch_contexts
                .consume(launch, "app", now)
                .unwrap()
                .expect("the first consume wins");
        }
        assert_eq!(
            launch_refusal_description(&code_authorization_starter, "launch-1", now),
            Some(OAuthErrorKind::LaunchAlreadyUsed.description()),
        );
        assert_eq!(
            launch_refusal_page(&code_authorization_starter, "launch-2", now),
            Some(OAuthErrorKind::LaunchAlreadyUsed),
        );
    }

    /// A request refused for another reason leaves its launch unspent.
    #[test]
    fn a_refused_request_leaves_its_launch_unspent() {
        let code_authorization_starter = registered_app_starter();
        let now = Utc::now();
        launch_contexts_of(&code_authorization_starter)
            .mint("app", "launch-1".to_owned(), now)
            .unwrap();
        let wrong_aud = AuthorizeRequest {
            launch: Some("launch-1"),
            aud: Some("https://other.relay.example"),
            ..request("app", "openid")
        };
        assert!(code_authorization_starter
            .start(&wrong_aud, ids(), now)
            .is_err());
        assert!(launch_contexts_of(&code_authorization_starter)
            .consume("launch-1", "app", now)
            .unwrap()
            .is_ok());
    }

    /// When the launch binds a patient, a standing grant for a different
    /// patient doesn't take the fast path: the Owner decides, and the request
    /// carries the launch's patient.
    #[test]
    fn a_launch_bound_patient_the_grant_does_not_name_waits_for_the_owner() {
        let store = FakeGrantStore::default();
        store.upsert_client(&client("app", &["openid"])).unwrap();
        store
            .create_authorization_code_grant(&AuthorizationCodeGrant {
                scopes: vec!["openid".to_owned()],
                patient: Some("pat-1".to_owned()),
                ..code_grant("g1", "app")
            })
            .unwrap();
        let now = Utc::now();
        store
            .with_connection(|tx| {
                tx.insert_launch_context(&LaunchContext::for_client(
                    "launch-1".to_owned(),
                    "app",
                    Some("pat-2".to_owned()),
                    now,
                ))
            })
            .unwrap();
        let (code_authorization_starter, _) = starter(store);
        let authorize_query = AuthorizeRequest {
            launch: Some("launch-1"),
            ..request("app", "openid")
        };
        assert_eq!(
            code_authorization_starter
                .start(&authorize_query, ids(), now)
                .expect("starts"),
            AuthorizeNextStep::AwaitOwner {
                request_id: "req-1".to_owned(),
                decidable_in_requesting_browser: false,
            }
        );
        let parked_request = code_authorization_starter
            .store
            .authorization_request_by_id("req-1")
            .unwrap()
            .expect("parked");
        assert_eq!(parked_request.status, RequestStatus::Pending);
        assert_eq!(
            parked_request.launch_bound_patient.as_deref(),
            Some("pat-2")
        );
    }

    /// Whether the requesting browser decides a request turns on the
    /// request's approval scopes, the resource scopes it asks for among them:
    /// a browser that decides consents and creates grants and registrations,
    /// but holds no `patient/` scope, can't approve a request for
    /// `patient/Observation.rs`, so the request is raised for the Owner.
    #[test]
    fn the_requesting_browser_decides_only_a_request_it_can_approve_as_asked() {
        let deciding = [
            "wildflower/AuthorizationRequest.ru",
            "wildflower/Grant.c",
            "wildflower/Client.cu",
        ];
        for (extra_scopes, expected) in [(&[][..], false), (&["patient/Observation.rs"][..], true)]
        {
            let store = FakeGrantStore::default();
            store
                .upsert_client(&client("app", &["patient/Observation.rs"]))
                .unwrap();
            let (code_authorization_starter, _) = starter(store);
            let requesting_browser_grant = Grant::parse(deciding.iter().chain(extra_scopes));
            let outcome = code_authorization_starter
                .start(
                    &AuthorizeRequest {
                        requesting_browser_grant: Some(&requesting_browser_grant),
                        ..request("app", "patient/Observation.rs")
                    },
                    ids(),
                    Utc::now(),
                )
                .expect("starts");
            assert_eq!(
                outcome,
                AuthorizeNextStep::AwaitOwner {
                    request_id: "req-1".to_owned(),
                    decidable_in_requesting_browser: expected,
                },
                "{extra_scopes:?}"
            );
        }
    }

    /// A request about to be raised for the Owner asks whether it may be,
    /// and parks nothing when refused; one decided in the requesting browser
    /// never asks.
    #[test]
    fn only_a_request_raised_for_the_owner_asks_the_start_limit() {
        let (code_authorization_starter, owner_approval) = starter(FakeGrantStore::default());
        let refused = code_authorization_starter.start(
            &AuthorizeRequest {
                may_raise_for_owner: &|| false,
                ..request("newcomer", "openid")
            },
            ids(),
            Utc::now(),
        );
        assert!(matches!(
            refused,
            Err(AuthorizationStartError::StartLimited)
        ));
        assert_eq!(
            code_authorization_starter
                .store
                .authorization_request_by_id("req-1")
                .unwrap(),
            None
        );
        assert_eq!(owner_approval.count(), 0);

        let owner_session_grant = Grant::parse(crate::owner_scopes());
        let outcome = code_authorization_starter
            .start(
                &AuthorizeRequest {
                    requesting_browser_grant: Some(&owner_session_grant),
                    may_raise_for_owner: &|| panic!("decided in the requesting browser"),
                    ..request("newcomer", "openid")
                },
                ids(),
                Utc::now(),
            )
            .expect("starts");
        assert_eq!(
            outcome,
            AuthorizeNextStep::AwaitOwner {
                request_id: "req-1".to_owned(),
                decidable_in_requesting_browser: true,
            }
        );
    }

    /// A store holding a registered "app" with a standing grant that covers
    /// `patient/Patient.r patient/Observation.r openid`, so a request for them
    /// would take the fast path.
    fn covered_app_store() -> FakeGrantStore {
        let store = FakeGrantStore::default();
        store
            .upsert_client(&client(
                "app",
                &["patient/Patient.r", "patient/Observation.r", "openid"],
            ))
            .unwrap();
        store
            .create_authorization_code_grant(&AuthorizationCodeGrant {
                scopes: vec!["patient/*.cruds".to_owned(), "openid".to_owned()],
                ..code_grant("g1", "app")
            })
            .unwrap();
        store
    }

    /// The scopes [`covered_app_store`]'s grant covers.
    const COVERED_SCOPES: &str = "patient/Patient.r patient/Observation.r openid";

    /// A request whose browser session falls short of it parks for the
    /// limited page, once its launch is spent, before the fast path, the
    /// start limit and the Owner: nothing is issued, asked or raised.
    #[test]
    fn a_request_its_session_falls_short_of_waits_on_the_limited_page() {
        let (code_authorization_starter, owner_approval) = starter(covered_app_store());
        let now = Utc::now();
        launch_contexts_of(&code_authorization_starter)
            .mint("app", "launch-1".to_owned(), now)
            .unwrap();
        let limited_grant = Grant::parse(["patient/Patient.rs"]);
        let outcome = code_authorization_starter
            .start(
                &AuthorizeRequest {
                    browser_session_grant: &limited_grant,
                    launch: Some("launch-1"),
                    may_raise_for_owner: &|| panic!("nothing is raised yet"),
                    ..request("app", COVERED_SCOPES)
                },
                ids(),
                now,
            )
            .expect("starts");
        assert_eq!(
            outcome,
            AuthorizeNextStep::ConfirmSessionShortfall {
                request_id: "req-1".to_owned()
            }
        );
        let parked_request = code_authorization_starter
            .store
            .authorization_request_by_id("req-1")
            .unwrap()
            .expect("parked");
        assert_eq!(parked_request.status, RequestStatus::Pending);
        assert!(!parked_request.session_shortfall_acknowledged);
        assert_eq!(parked_request.launch.as_deref(), Some("launch-1"));
        assert_eq!(
            code_authorization_starter
                .store
                .authorization_code_by_request_id("req-1")
                .unwrap(),
            None
        );
        assert_eq!(owner_approval.count(), 0);
        assert_eq!(
            code_authorization_starter
                .store
                .newest_pending_consent()
                .unwrap(),
            None
        );
    }

    /// Start `COVERED_SCOPES` for "app" in a session holding only
    /// `patient/Patient.rs`, so it waits on the limited page as "req-1".
    fn park_for_the_limited_page(
        code_authorization_starter: &CodeAuthorizationStarter<FakeGrantStore>,
    ) {
        let limited_grant = Grant::parse(["patient/Patient.rs"]);
        let outcome = code_authorization_starter
            .start(
                &AuthorizeRequest {
                    browser_session_grant: &limited_grant,
                    ..request("app", COVERED_SCOPES)
                },
                ids(),
                Utc::now(),
            )
            .expect("starts");
        assert!(matches!(
            outcome,
            AuthorizeNextStep::ConfirmSessionShortfall { .. }
        ));
    }

    /// Going on past the limited page takes the fast path the start would
    /// have taken: the request is acknowledged and approved, and the code
    /// carries only what the requesting session holds.
    #[test]
    fn continuing_past_the_shortfall_takes_the_fast_path() {
        let (code_authorization_starter, owner_approval) = starter(covered_app_store());
        park_for_the_limited_page(&code_authorization_starter);
        let outcome = code_authorization_starter
            .continue_past_session_shortfall(
                "req-1",
                REQUESTING_SID,
                &|| panic!("the fast path asks no limit"),
                "the-code".to_owned(),
                Utc::now(),
            )
            .expect("continues");
        assert_eq!(
            outcome,
            AuthorizeNextStep::RedirectToClient {
                redirect_uri: Url::parse("https://example.com/cb").unwrap(),
                code: "the-code".to_owned(),
                client_state: "xyz".to_owned(),
            }
        );
        let request = code_authorization_starter
            .store
            .authorization_request_by_id("req-1")
            .unwrap()
            .expect("present");
        assert_eq!(request.status, RequestStatus::Approved);
        assert!(request.session_shortfall_acknowledged);
        assert_eq!(
            code_authorization_starter
                .store
                .authorization_code_by_request_id("req-1")
                .unwrap()
                .expect("the code")
                .granted_scopes,
            ["openid"],
            "the requesting session holds only wildflower/launch"
        );
        assert_eq!(owner_approval.count(), 1);
    }

    /// With no standing grant, going on raises the request for the Owner once
    /// the start limit admits it; refused, the request still waits on the
    /// limited page and nothing is raised.
    #[test]
    fn continuing_without_a_standing_grant_raises_for_the_owner_once_admitted() {
        let store = FakeGrantStore::default();
        store
            .upsert_client(&client(
                "app",
                &["patient/Patient.r", "patient/Observation.r", "openid"],
            ))
            .unwrap();
        let (code_authorization_starter, owner_approval) = starter(store);
        park_for_the_limited_page(&code_authorization_starter);

        let refused = code_authorization_starter.continue_past_session_shortfall(
            "req-1",
            REQUESTING_SID,
            &|| false,
            "the-code".to_owned(),
            Utc::now(),
        );
        assert!(matches!(
            refused,
            Err(AuthorizationStartError::StartLimited)
        ));
        assert!(
            !code_authorization_starter
                .store
                .authorization_request_by_id("req-1")
                .unwrap()
                .expect("present")
                .session_shortfall_acknowledged
        );
        assert_eq!(owner_approval.count(), 0);

        let outcome = code_authorization_starter
            .continue_past_session_shortfall(
                "req-1",
                REQUESTING_SID,
                &|| true,
                "the-code".to_owned(),
                Utc::now(),
            )
            .expect("continues");
        assert_eq!(
            outcome,
            AuthorizeNextStep::AwaitOwner {
                request_id: "req-1".to_owned(),
                decidable_in_requesting_browser: false,
            }
        );
        assert_eq!(owner_approval.count(), 1);
        assert!(matches!(
            code_authorization_starter
                .store
                .newest_pending_consent()
                .unwrap(),
            Some(crate::domain::pending_consent::NewestPendingConsent::OAuth { .. })
        ));
    }

    /// Only the session the request was made in goes on with it, and only
    /// while it is unexpired and still waiting.
    #[test]
    fn only_the_requesting_session_continues_a_request_still_waiting() {
        let (code_authorization_starter, _) = starter(covered_app_store());
        park_for_the_limited_page(&code_authorization_starter);
        let not_found = |outcome: Result<AuthorizeNextStep, AuthorizationStartError>| {
            matches!(
                outcome,
                Err(AuthorizationStartError::Store(
                    AuthorizationServerError::AuthorizationRequestNotFound { .. }
                ))
            )
        };
        for (sid, now) in [
            ("another-sid", Utc::now()),
            (REQUESTING_SID, Utc::now() + AUTHORIZATION_REQUEST_TTL),
        ] {
            assert!(
                not_found(code_authorization_starter.continue_past_session_shortfall(
                    "req-1",
                    sid,
                    &|| true,
                    "the-code".to_owned(),
                    now,
                )),
                "{sid} at {now}"
            );
        }
        code_authorization_starter
            .continue_past_session_shortfall(
                "req-1",
                REQUESTING_SID,
                &|| true,
                "the-code".to_owned(),
                Utc::now(),
            )
            .expect("its own session goes on");
        assert!(not_found(
            code_authorization_starter.continue_past_session_shortfall(
                "req-1",
                REQUESTING_SID,
                &|| true,
                "another-code".to_owned(),
                Utc::now(),
            )
        ));
    }
}
