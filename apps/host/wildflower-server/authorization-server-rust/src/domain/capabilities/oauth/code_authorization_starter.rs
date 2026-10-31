//! [`CodeAuthorizationStarter`] — the `/oauth/authorize` flow (RFC 6749 §3.1,
//! §4.1.1; RFC 7636), for a browser that holds a browser session (the handler
//! sends one without a session to pairing first). Validates the request,
//! parks it, and either issues a
//! code on the spot under a
//! [`StandingGrantCoverage`]
//! proof (the one path that issues a code with no human in the loop — named as
//! an authority so it can be audited as such) or hands it to the Owner. A
//! SMART App Launch's `aud` is checked against this server, and its `launch`
//! is consumed and carried onto the parked request.
//!
//! A request asking for more than the browser's session holds (its **session
//! shortfall**: what a code issued in that session would not carry in full)
//! waits on that browser's limited page first, and goes on from there only
//! when the browser says to ([`CodeAuthorizationStarter::continue_past_session_shortfall`]).
//! What the session holds is read from its row, which a widening the Owner
//! approved grows. Once a browser session has gone on for a client, its later
//! requests for that client skip the page, whatever the session then lacks of
//! them, unless the app asks to show it again (`prompt=consent`).

use std::sync::Arc;

use chrono::{DateTime, Duration, Utc};
use url::Url;
use wildflowerhealthio_scopes::Grant;

use super::consume_launch;
use super::session_shortfall::{browser_session_grant, load_code_request_awaiting_limited_page};
use crate::crypto_util::pkce::is_valid_s256_code_challenge;
use crate::domain::authority::{session_shortfall, GrantCoverage, StandingGrantCoverage};
use crate::domain::authorization_request::code::resolved::ResolvedCodeRequest;
use crate::domain::authorization_request::code::{CodeRequest, NewCodeRequestArgs};
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::authorize_refusal::AuthorizeRefusal;
use crate::domain::browser_session::StaleSessionCutoff;
use crate::domain::capabilities::writers::{CodeApproval, CodeAuthority, RequestApprover};
use crate::domain::client_redirect::{
    BROWSER_SIGNED_OUT_DESCRIPTION, SCOPES_NOT_REGISTERED_DESCRIPTION,
};
use crate::domain::launch_context::LaunchRefusal;
use crate::domain::oauth_error_code::OAuthErrorCode;
use crate::domain::{GrantStore, GrantTx};
use crate::ports::OwnerApproval;

/// Lifetime of a parked code request: five minutes from its start, and again
/// from the moment its browser goes on past the limited page.
pub(crate) const AUTHORIZATION_REQUEST_TTL: Duration = Duration::minutes(5);

/// The RFC 6749 §4.1.1 + RFC 7636 request, as presented, with the optional
/// SMART App Launch parameters, and the facts about the requesting browser
/// that the handler worked out before calling in.
pub(crate) struct AuthorizeRequest<'a> {
    /// The OAuth `response_type`; only `code` is accepted.
    pub(crate) response_type: &'a str,
    /// The PKCE challenge method; only `S256` is accepted.
    pub(crate) code_challenge_method: &'a str,
    /// The client asking.
    pub(crate) client_id: &'a str,
    /// What the client asks for, space-separated.
    pub(crate) scope: &'a str,
    /// The PKCE S256 challenge, which the code's redeemer must answer with
    /// its verifier.
    pub(crate) code_challenge: &'a str,
    /// Where the client wants the answer. Until it is registered to the
    /// client, failures render locally rather than go there.
    pub(crate) redirect_uri: &'a str,
    /// The client's `state`, echoed back on every answer that reaches it.
    pub(crate) client_state: &'a str,
    /// The SMART App Launch `launch` value the app was launched with, or
    /// `None` for a plain OAuth request.
    pub(crate) launch: Option<&'a str>,
    /// The SMART App Launch `aud`: the FHIR server the app means to call with
    /// the token, or `None` when the app doesn't declare one.
    pub(crate) aud: Option<&'a str>,
    /// The grant the browser's session token (its cookie) carries: what the
    /// browser can do as a bearer on this server's pages, the consent card
    /// among them. What the session bounds a code to is read from its row
    /// instead, which a widening the browser hasn't taken a token for yet
    /// may have grown.
    pub(crate) session_token_grant: &'a Grant,
    /// Whether that browser session can decide consents. The request can be
    /// decided in that browser when it can and
    /// [`session_token_grant`](Self::session_token_grant) also holds the
    /// request's approval scopes (as the consent card and the approval check
    /// them with [`missing_approval_scopes`]); that is recorded on a parked
    /// request.
    ///
    /// [`missing_approval_scopes`]:
    /// crate::domain::authority::ApprovableScopes::missing_approval_scopes
    pub(crate) can_decide_consents: bool,
    /// Whether this start may raise a request for the Owner, asked once, only
    /// when the request is about to be (not decided in the requesting browser,
    /// and not issued on the standing-grant fast path) or about to park for
    /// its browser's limited page. The authorization start limit, deferred to
    /// here for a browser that can decide consents so that the requests it
    /// decides itself spend nothing; `true` for a start the limit already
    /// admitted. It is a closure, not a flag, because only the starter knows
    /// whether the request will bother the Owner.
    pub(crate) may_raise_for_owner: &'a dyn Fn() -> bool,
    /// The browser session the browser making the request holds, recorded on
    /// the parked request and on the code it earns. A browser without one
    /// never gets this far: `/oauth/authorize` sends it to pairing.
    pub(crate) sid: &'a str,
    /// Whether the app asked (`prompt=consent`) for a session shortfall to
    /// be shown on the limited page even when this session has gone on past
    /// it for the client before. It changes nothing for a request the
    /// session holds all of.
    pub(crate) reviews_session_shortfall: bool,
}

/// The identifiers a start may need, minted by the caller (a random UUID and
/// a random code) so tests can inject known values.
pub(crate) struct FreshIds {
    /// The parked request's id.
    pub(crate) request_id: String,
    /// The authorization code, used only when the request is issued one on
    /// the spot under a standing grant.
    pub(crate) code: String,
}

/// Where the user-agent goes next after `/authorize`, or after a Continue on
/// the limited page. The route turns each into a location.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum AuthorizeNextStep {
    /// Every requested scope was pre-approved: back to the client with a code
    /// (RFC 6749 §4.1.2).
    RedirectToClient {
        /// The redirect the client presented, registered to it.
        redirect_uri: Url,
        /// The code just issued under the standing grant.
        code: String,
        /// The client's `state`, carried back on the callback.
        client_state: String,
    },
    /// The request is parked for the Owner: decided in the browser making it,
    /// on the consent card, when `decidable_in_requesting_browser`, and
    /// otherwise raised for the Owner while the user-agent polls the wait
    /// page for the decision.
    AwaitOwner {
        /// The parked request: the `$id` of the consent card or the wait page.
        request_id: String,
        /// Whether the request is decided on the consent card in this browser
        /// rather than by the Owner elsewhere.
        decidable_in_requesting_browser: bool,
    },
    /// The browser's session holds less than the request asks for: the
    /// request is parked for that browser's limited page, which says so and
    /// goes on only when the browser does. The start limit has admitted it and
    /// its launch, if any, is consumed; no code is issued and nothing is
    /// raised for the Owner yet.
    ConfirmSessionShortfall {
        /// The parked request: the `$id` of the limited page.
        request_id: String,
    },
}

/// The ways starting an authorization can fail. `LocalPage` failures render
/// locally because the `redirect_uri` is not (yet) trusted; `Redirectable`
/// ones go back to the validated client redirect per RFC 6749 §4.1.2.1.
#[derive(Debug)]
pub(crate) enum AuthorizationStartError {
    /// No active signing key: the endpoint cannot issue codes, so it refuses up
    /// front rather than parking a request it can never complete.
    NoActiveSigningKey,
    /// A failure on a request whose `redirect_uri` is not trusted, shown as
    /// this server's own page: sending an error to an untrusted redirect
    /// would make the server an open redirector.
    LocalPage(AuthorizeRefusal),
    /// A spec'd error once `redirect_uri` is validated, with the sentence the
    /// redirect carries as its `error_description`. The URL is boxed to keep
    /// the error small enough for `clippy::result_large_err`.
    Redirectable {
        /// The client's trusted redirect, which the error goes back to.
        redirect_uri: Box<Url>,
        /// The OAuth `error` code.
        error: OAuthErrorCode,
        /// The sentence the redirect carries as its `error_description`.
        description: &'static str,
        /// The client's `state`, carried back on the callback.
        client_state: String,
    },
    /// The request this flow just parked was no longer pending when the fast
    /// path approved it — an unexpected concurrent transition. It rolls the
    /// scope back.
    RequestNotPending,
    /// The request would be raised for the Owner, or parked for its limited
    /// page, and
    /// [`may_raise_for_owner`](AuthorizeRequest::may_raise_for_owner) refused:
    /// the authorization start limit. Nothing is parked and the Owner isn't
    /// told.
    StartLimited,
    /// A store failure; or, from a Continue,
    /// [`AuthorizationServerError::AuthorizationRequestNotFound`] for a
    /// request no longer waiting on its limited page.
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
    /// The store each start or Continue validates, parks and decides in, in
    /// one write scope.
    store: S,
    /// Republishes the Owner prompt once a scope that may have changed it
    /// commits, so the popup never shows a request a rolled-back scope didn't
    /// keep.
    owner_approval: Arc<dyn OwnerApproval>,
    /// The server's bare origin, `https://<domain>`, also its FHIR base: an
    /// `aud` must name it.
    server_origin: Arc<str>,
    /// The cutoff before which a same-device session is stale: a request's
    /// browser session needs to be live under it for the fast path to issue
    /// it a code.
    stale_session_cutoff: Arc<StaleSessionCutoff>,
}

impl<S: GrantStore> CodeAuthorizationStarter<S> {
    /// Build the starter over the store, the popup republish port, the
    /// server's origin and the stale-session cutoff — all lifted from the
    /// state.
    pub(crate) fn new(
        store: S,
        owner_approval: Arc<dyn OwnerApproval>,
        server_origin: Arc<str>,
        stale_session_cutoff: Arc<StaleSessionCutoff>,
    ) -> Self {
        CodeAuthorizationStarter {
            store,
            owner_approval,
            server_origin,
            stale_session_cutoff,
        }
    }

    /// Validate `authorize_query` (client and redirect first, then the redirectable
    /// params), park it, and decide: a fully pre-approved request is issued a
    /// code under the standing grant's authority and sent back to the client;
    /// anything else waits on the Owner as a pending consent. It all happens in
    /// one write scope, so a refusal from inside it rolls everything back,
    /// a spent launch included; the Owner prompt is republished once that has
    /// committed.
    ///
    /// The request is resolved against its client's registration
    /// ([`ResolvedCodeRequest`]). A disabled client is refused. A fixed
    /// (server-defined) registration holds the request to its redirects and
    /// scopes. Any other client is trusted on first use: a request outside the
    /// registration is parked with a warning rather than rejected, never takes
    /// the fast path, and — while its redirect is untrusted — renders every
    /// failure locally rather than risk an open redirect.
    ///
    /// A declared `aud` must be this server's origin (its FHIR base). A
    /// `launch` must name an unconsumed, unexpired launch context minted for
    /// this client or for the server launcher; it is consumed (so it never works twice)
    /// and carried onto the parked request. Either failure is
    /// `invalid_request`, and its description says why: a client sees its own
    /// launch's state (not recognized, already used, expired), and another
    /// app's launch looks unknown. A request with no `launch` is plain
    /// OAuth. When the launch binds a patient, the fast path applies only if
    /// the standing grant names the same one; otherwise the Owner decides.
    ///
    /// A request whose browser session holds less than it asks for (see
    /// [`session_shortfall`], against the session's row) is parked, once
    /// validated, admitted by the start limit and its launch consumed, for its
    /// browser's limited page ([`AuthorizeNextStep::ConfirmSessionShortfall`]);
    /// the fast path and the Owner wait for
    /// [`continue_past_session_shortfall`](Self::continue_past_session_shortfall).
    /// A session that has gone on past the page for this client before goes
    /// on as if it had again, unless the request
    /// [reviews the shortfall](AuthorizeRequest::reviews_session_shortfall).
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
        let decided = self
            .store
            .write(|tx| self.start_in(tx, authorize_query, ids, now))?;
        self.publish(decided)
    }

    /// Go on with request `id`, which waits on the limited page of the
    /// browser holding the browser session `sid`: go on past the page (the
    /// request becomes pending, with a fresh [`AUTHORIZATION_REQUEST_TTL`]
    /// from `now`),
    /// remember that `sid` went on for the request's client (so its later
    /// requests for that client skip the page), and take the branch
    /// [`start`](Self::start) would have taken had the session held all it
    /// asks for. Its standing-grant coverage is
    /// read again (the Owner may have approved or revoked a grant meanwhile),
    /// so a covered request is issued `code` under it, and any other is raised
    /// for the Owner, and decided on the consent card or the wait page as
    /// recorded at its start. The start limit isn't asked: the request spent
    /// from it when it parked.
    ///
    /// # Errors
    ///
    /// [`AuthorizationStartError::Store`] with
    /// [`AuthorizationServerError::AuthorizationRequestNotFound`] for a
    /// request no longer waiting on that page (another session's, already
    /// gone on, decided, or expired: the same as an expired request
    /// anywhere else); [`AuthorizationStartError::NoActiveSigningKey`], as at
    /// the start, leaving the request waiting;
    /// [`AuthorizationStartError::Redirectable`] with `access_denied` for a
    /// client disabled since, the request denied (the limited page follows
    /// it as it follows Cancel's); otherwise as [`start`](Self::start).
    pub(crate) fn continue_past_session_shortfall(
        &self,
        id: &str,
        sid: &str,
        code: String,
        now: DateTime<Utc>,
    ) -> Result<AuthorizeNextStep, AuthorizationStartError> {
        let decided = self
            .store
            .write(|tx| self.continue_in(tx, id, sid, code, now))?;
        self.publish(decided)
    }

    /// Republish the Owner prompt when `decided` may have changed it, and
    /// answer with its next step, or hand on its refusal. It runs after the
    /// scope commits, so the popup never shows a request a rolled-back scope
    /// didn't keep.
    fn publish(&self, decided: Decided) -> Result<AuthorizeNextStep, AuthorizationStartError> {
        if decided.pending_consents_changed {
            self.owner_approval.republish_active();
        }
        decided.next_step
    }

    /// [`start`](Self::start)'s flow, inside its write scope `tx`.
    fn start_in<T: GrantTx>(
        &self,
        tx: &mut T,
        authorize_query: &AuthorizeRequest<'_>,
        ids: FreshIds,
        now: DateTime<Utc>,
    ) -> Result<Decided, AuthorizationStartError> {
        if !tx.has_active_signing_key()? {
            return Err(AuthorizationStartError::NoActiveSigningKey);
        }
        let maybe_existing_client = tx.client_by_id(authorize_query.client_id)?;
        let requested_redirect_uri = parse_redirect_uri(authorize_query.redirect_uri)?;
        let requested_scopes: Vec<String> = authorize_query
            .scope
            .split_whitespace()
            .map(str::to_string)
            .collect();
        let resolved = ResolvedCodeRequest::resolve(
            authorize_query.client_id,
            &requested_redirect_uri,
            &requested_scopes,
            maybe_existing_client.as_ref(),
        );
        if resolved.is_client_disabled() {
            return Err(AuthorizationStartError::LocalPage(
                AuthorizeRefusal::DisabledClient,
            ));
        }
        // A redirect is trustworthy only when a client we already know already
        // registered it.
        let redirect_trusted = resolved.is_redirect_registered();
        if resolved.is_registration_fixed() && !redirect_trusted {
            return Err(AuthorizationStartError::LocalPage(
                AuthorizeRefusal::RedirectUriNotAllowed,
            ));
        }
        validate_code_params(
            authorize_query,
            &requested_redirect_uri,
            redirect_trusted,
            &self.server_origin,
        )?;
        if resolved.is_registration_fixed() && !resolved.are_scopes_registered() {
            return Err(AuthorizationStartError::Redirectable {
                redirect_uri: Box::new(requested_redirect_uri),
                error: OAuthErrorCode::InvalidScope,
                description: SCOPES_NOT_REGISTERED_DESCRIPTION,
                client_state: authorize_query.client_state.to_owned(),
            });
        }
        let decidable_in_requesting_browser = authorize_query.can_decide_consents
            && resolved
                .approvable_scopes()
                .missing_approval_scopes(authorize_query.session_token_grant)
                .is_empty();
        let coverage = GrantCoverage::resolve(
            tx,
            resolved.presented_client_change(),
            authorize_query.client_id,
            &requested_redirect_uri,
            &requested_scopes,
        )?;
        // A session that ended since its cookie was checked parks nothing for
        // the limited page: the request goes on, and is denied once a code
        // would be issued under the session.
        let session_falls_short =
            browser_session_grant(tx, authorize_query.sid, &self.stale_session_cutoff, now)?
                .is_some_and(|session_grant| {
                    !session_shortfall(&requested_scopes, &session_grant).is_empty()
                });
        let waits_on_limited_page = session_falls_short
            && (authorize_query.reviews_session_shortfall
                || !tx.is_session_shortfall_acknowledged_for_client(
                    authorize_query.sid,
                    authorize_query.client_id,
                )?);
        // Parking for the limited page writes a request and spends its launch,
        // so it asks the start limit as raising one for the Owner does. Continue
        // then raises it without asking again.
        if waits_on_limited_page && !(authorize_query.may_raise_for_owner)() {
            return Err(AuthorizationStartError::StartLimited);
        }

        // Consume the launch last, after every check that can refuse the
        // request; a refusal after it rolls the scope back, so a refused
        // request leaves its launch unspent.
        let launch_context = match authorize_query.launch {
            None => None,
            Some(launch) => match consume_launch(tx, launch, authorize_query.client_id, now)? {
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
                        redirect_trusted,
                        OAuthErrorCode::InvalidRequest,
                        launch_refusal_kind(launch_refusal),
                    ));
                }
            },
        };

        let (launch, launch_bound_patient) = launch_context.map_or((None, None), |context| {
            let launch_bound_patient = context.patient().map(str::to_owned);
            (Some(context.nonce), launch_bound_patient)
        });
        let parked_request = CodeRequest::new(
            NewCodeRequestArgs {
                id: ids.request_id.clone(),
                client_id: authorize_query.client_id.to_owned(),
                requested_scopes,
                ttl: AUTHORIZATION_REQUEST_TTL,
                redirect_uri: requested_redirect_uri,
                code_challenge: authorize_query.code_challenge.to_owned(),
                client_state: authorize_query.client_state.to_owned(),
                sid: authorize_query.sid.to_owned(),
                launch,
                launch_bound_patient,
                pre_approved_scopes: coverage.pre_approved_scopes().to_vec(),
                decidable_in_requesting_browser,
                awaits_limited_page: waits_on_limited_page,
            },
            now,
        );
        // The session falls short, and hasn't gone on for this client before:
        // park the request for its browser's limited page. The Owner isn't
        // told of it, so nothing is republished.
        if waits_on_limited_page {
            tx.insert_code_request(&parked_request)?;
            return Ok(Decided {
                next_step: Ok(AuthorizeNextStep::ConfirmSessionShortfall {
                    request_id: ids.request_id,
                }),
                pending_consents_changed: false,
            });
        }
        let fast_path_coverage = fast_path_coverage(&parked_request, coverage);
        // A request about to be raised for the Owner asks the start limit
        // first.
        if fast_path_coverage.is_none()
            && !decidable_in_requesting_browser
            && !(authorize_query.may_raise_for_owner)()
        {
            return Err(AuthorizationStartError::StartLimited);
        }
        decide(
            tx,
            &parked_request,
            fast_path_coverage,
            ids.code,
            &self.stale_session_cutoff,
            now,
            // Park the request — every path from here on references it by id.
            |tx| {
                tx.insert_code_request(&parked_request)?;
                Ok(parked_request.clone())
            },
        )
    }

    /// [`continue_past_session_shortfall`](Self::continue_past_session_shortfall)'s
    /// flow, inside its write scope `tx`.
    fn continue_in<T: GrantTx>(
        &self,
        tx: &mut T,
        id: &str,
        sid: &str,
        code: String,
        now: DateTime<Utc>,
    ) -> Result<Decided, AuthorizationStartError> {
        if !tx.has_active_signing_key()? {
            return Err(AuthorizationStartError::NoActiveSigningKey);
        }
        let parked_request = load_code_request_awaiting_limited_page(tx, id, sid, now)?;
        let maybe_existing_client = tx.client_by_id(&parked_request.client_id)?;
        let resolved = ResolvedCodeRequest::resolve(
            &parked_request.client_id,
            &parked_request.redirect_uri,
            &parked_request.requested_scopes,
            maybe_existing_client.as_ref(),
        );
        // The client was disabled since the request parked: the browser can't
        // go on with it, so it ends here, and the app hears why.
        if resolved.is_client_disabled() {
            return refuse_waiting_request(
                tx,
                &parked_request,
                AuthorizeRefusal::DisabledClient,
                now,
            );
        }
        let coverage = GrantCoverage::resolve(
            tx,
            resolved.presented_client_change(),
            &parked_request.client_id,
            &parked_request.redirect_uri,
            &parked_request.requested_scopes,
        )?;
        // The start limit isn't asked: the request spent from it when it
        // parked.
        decide(
            tx,
            &parked_request,
            fast_path_coverage(&parked_request, coverage),
            code,
            &self.stale_session_cutoff,
            now,
            |tx| {
                let not_found = || {
                    AuthorizationStartError::Store(
                        AuthorizationServerError::AuthorizationRequestNotFound {
                            id: id.to_owned(),
                        },
                    )
                };
                let continued = parked_request
                    .acknowledge_session_shortfall(AUTHORIZATION_REQUEST_TTL, now)
                    .map_err(|_| not_found())?;
                if !tx.replace_code_request(&parked_request, &continued)? {
                    return Err(not_found());
                }
                tx.record_session_shortfall_acknowledgement(sid, &parked_request.client_id)?;
                Ok(continued)
            },
        )
    }
}

/// What a start's or continue's scope committed: the step the user-agent
/// takes next, or the refusal it is sent away with, and whether the Owner
/// prompt may have changed, to be republished once the scope has closed.
struct Decided {
    /// The next step, or a refusal that keeps what the scope wrote: the fast
    /// path's denial for an ended browser session, and a Continue's denial
    /// for a client disabled since the request parked. A refusal that must
    /// roll the scope back is the scope's own `Err` instead.
    next_step: Result<AuthorizeNextStep, AuthorizationStartError>,
    /// Whether the Owner prompt may have changed, so it is republished.
    pending_consents_changed: bool,
}

/// Deny `parked_request`, still waiting on its limited page, for `refusal`
/// at `now`, in the scope `tx`, and send the app `access_denied` carrying `refusal`'s
/// sentence. A request no longer waiting there (a Cancel won) is not found.
fn refuse_waiting_request(
    tx: &mut impl GrantTx,
    parked_request: &CodeRequest,
    refusal: AuthorizeRefusal,
    now: DateTime<Utc>,
) -> Result<Decided, AuthorizationStartError> {
    let not_found = || {
        AuthorizationStartError::Store(AuthorizationServerError::AuthorizationRequestNotFound {
            id: parked_request.id.clone(),
        })
    };
    let refused = parked_request
        .deny_on_limited_page(now)
        .map_err(|_| not_found())?;
    if !tx.replace_code_request(parked_request, &refused)? {
        return Err(not_found());
    }
    Ok(Decided {
        next_step: Err(AuthorizationStartError::Redirectable {
            redirect_uri: Box::new(parked_request.redirect_uri.clone()),
            error: OAuthErrorCode::AccessDenied,
            description: refusal.description(),
            client_state: parked_request.client_state.clone(),
        }),
        pending_consents_changed: false,
    })
}

/// The standing grant's coverage of `request` when it can take the fast
/// path: `coverage` is full, and the standing grant's patient is one the
/// launch admits.
fn fast_path_coverage(
    request: &CodeRequest,
    coverage: GrantCoverage,
) -> Option<StandingGrantCoverage> {
    match coverage {
        GrantCoverage::Full(standing_grant_coverage)
            if request.admits_patient(standing_grant_coverage.patient()) =>
        {
            Some(standing_grant_coverage)
        }
        _ => None,
    }
}

/// The shared tail of [`CodeAuthorizationStarter::start`] and
/// [`CodeAuthorizationStarter::continue_past_session_shortfall`], in their
/// scope `tx`, for `request`, whose session holds all it asks for or whose
/// browser has said to go on, and which the start limit has admitted: `park`
/// it (insert it, or go on past its limited page), which answers with the
/// request as parked, then issue `code` under the standing grant when
/// `fast_path_coverage` holds it, under `stale_session_cutoff`, or else raise
/// it for the Owner.
fn decide<T: GrantTx>(
    tx: &mut T,
    request: &CodeRequest,
    fast_path_coverage: Option<StandingGrantCoverage>,
    code: String,
    stale_session_cutoff: &StaleSessionCutoff,
    now: DateTime<Utc>,
    park: impl FnOnce(&mut T) -> Result<CodeRequest, AuthorizationStartError>,
) -> Result<Decided, AuthorizationStartError> {
    let decidable_in_requesting_browser = request.decidable_in_requesting_browser;
    let parked_request = park(tx)?;

    let next_step = match fast_path_coverage {
        Some(standing_grant_coverage) => issue_under_standing_grant(
            tx,
            &standing_grant_coverage,
            &parked_request,
            code,
            stale_session_cutoff,
            now,
        )?,
        None => Ok(AuthorizeNextStep::AwaitOwner {
            request_id: parked_request.id.clone(),
            decidable_in_requesting_browser,
        }),
    };
    // A request raised for the Owner is newly pending; one the fast path
    // decided may have been the Owner prompt for the width of the approval,
    // so the prompt is recomputed either way.
    Ok(Decided {
        next_step,
        pending_consents_changed: true,
    })
}

/// The fast path's approval, in the scope `tx`: the one place a code is
/// issued with no person deciding, its authority the standing grant. It goes
/// through the same writer as the Owner's approval, naming
/// [`CodeAuthority::StandingGrant`], so every code issued here can be found
/// by that name. The two `Result`s say which outcomes keep what the scope
/// wrote:
///
///  - issued: [`AuthorizeNextStep::RedirectToClient`] with the code; the
///    scope commits the approved request, its code, and the standing grant's
///    `last_used_at` stamped with `now`;
///  - the request's browser session is no longer live under
///    `stale_session_cutoff`: `access_denied` to the client, saying the
///    browser signed out; the scope commits the request denied, since there
///    is nothing to bound the code by and nothing to revoke later;
///  - the request was no longer pending:
///    [`AuthorizationStartError::RequestNotPending`], which rolls the scope
///    back.
fn issue_under_standing_grant(
    tx: &mut impl GrantTx,
    standing_grant_coverage: &StandingGrantCoverage,
    parked_request: &CodeRequest,
    code: String,
    stale_session_cutoff: &StaleSessionCutoff,
    now: DateTime<Utc>,
) -> Result<Result<AuthorizeNextStep, AuthorizationStartError>, AuthorizationStartError> {
    let requested_redirect_uri = parked_request.redirect_uri.clone();
    let client_state = &parked_request.client_state;
    match RequestApprover::within(tx).approve_for_code(
        CodeAuthority::StandingGrant(standing_grant_coverage),
        parked_request,
        standing_grant_coverage.patient(),
        code,
        stale_session_cutoff,
        now,
    )? {
        CodeApproval::Issued(issued_code) => Ok(Ok(AuthorizeNextStep::RedirectToClient {
            redirect_uri: requested_redirect_uri,
            code: issued_code.code,
            client_state: client_state.to_owned(),
        })),
        CodeApproval::RequestNotPending => Err(AuthorizationStartError::RequestNotPending),
        CodeApproval::BrowserSessionEnded => Ok(Err(AuthorizationStartError::Redirectable {
            redirect_uri: Box::new(requested_redirect_uri),
            error: OAuthErrorCode::AccessDenied,
            description: BROWSER_SIGNED_OUT_DESCRIPTION,
            client_state: client_state.to_owned(),
        })),
    }
}

/// The presented `redirect_uri` must be a well-formed http/https URL (RFC 6749
/// §4.1.2.1); either failure is an unconditional local page.
fn parse_redirect_uri(redirect_uri: &str) -> Result<Url, AuthorizationStartError> {
    let parsed = Url::parse(redirect_uri)
        .map_err(|_| AuthorizationStartError::LocalPage(AuthorizeRefusal::InvalidRedirectUri))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(AuthorizationStartError::LocalPage(
            AuthorizeRefusal::InvalidScheme,
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
    let fail = |error: OAuthErrorCode, local: AuthorizeRefusal| {
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
            AuthorizeRefusal::UnsupportedResponseType,
        ));
    }
    // Only S256 PKCE is supported; anything else is `invalid_request` (RFC
    // 7636 §4.4.1), as is a malformed challenge.
    if authorize_query.code_challenge_method != "S256" {
        return Err(fail(
            OAuthErrorCode::InvalidRequest,
            AuthorizeRefusal::UnsupportedCodeChallengeMethod,
        ));
    }
    if !is_valid_s256_code_challenge(authorize_query.code_challenge) {
        return Err(fail(
            OAuthErrorCode::InvalidRequest,
            AuthorizeRefusal::InvalidCodeChallenge,
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
                AuthorizeRefusal::InvalidAudience,
            ));
        }
    }
    Ok(())
}

/// The reason a client is told for `launch_refusal`. Another app's launch
/// reads exactly like one that doesn't exist, so a client learns nothing about
/// it; only the server's own log tells the two apart.
fn launch_refusal_kind(launch_refusal: LaunchRefusal) -> AuthorizeRefusal {
    match launch_refusal {
        LaunchRefusal::Unknown | LaunchRefusal::ForAnotherApp => AuthorizeRefusal::LaunchUnknown,
        LaunchRefusal::AlreadyUsed => AuthorizeRefusal::LaunchAlreadyUsed,
        LaunchRefusal::Expired => AuthorizeRefusal::LaunchExpired,
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
    local: AuthorizeRefusal,
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
    use crate::domain::grant_store::*;

    use super::*;
    use crate::domain::authorization_request::code::CodeRequestState;
    use crate::domain::authorization_request::RequestStatus;
    use crate::domain::browser_session::BrowserSession;
    use crate::domain::client::{Client, ClientKind, RegistrationSource};
    use crate::domain::grant::AuthorizationCodeGrant;
    use crate::domain::launch_context::{LaunchContext, LaunchRefusal, LAUNCH_CONTEXT_TTL};

    use crate::domain::test_fake::{
        client, code_grant, fixture_code_args, owned_scopes, seed_active_signing_key,
        FakeGrantStore, RecordingOwnerApproval, FIXTURE_SID,
    };

    /// A well-formed PKCE S256 challenge (RFC 7636 Appendix B's).
    const CHALLENGE: &str = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    /// The server's origin, also its FHIR base: the one `aud` accepted.
    const SERVER_ORIGIN: &str = "https://ruth.relay.example";
    /// The browser session every request here is made in, standing in the
    /// starter's store.
    const REQUESTING_SID: &str = "requesting-sid";

    /// The grant of a browser session that holds all the Owner holds, so it
    /// falls short of no request.
    static SAME_DEVICE_SESSION_GRANT: std::sync::LazyLock<Grant> =
        std::sync::LazyLock::new(|| Grant::parse(crate::owner_scopes()));

    /// A valid code request from `client_id` for `scope`, to
    /// `https://example.com/cb` with state `xyz`, no launch and no `aud`, made
    /// in [`REQUESTING_SID`] by a browser whose session falls short of
    /// nothing, can't decide consents, and is always admitted by the start
    /// limit.
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
            session_token_grant: &SAME_DEVICE_SESSION_GRANT,
            can_decide_consents: false,
            may_raise_for_owner: &|| true,
            sid: REQUESTING_SID,
            reviews_session_shortfall: false,
        }
    }

    /// The fresh ids every start here mints: request `req-1`, code
    /// `the-code`.
    fn ids() -> FreshIds {
        FreshIds {
            request_id: "req-1".to_owned(),
            code: "the-code".to_owned(),
        }
    }

    /// A starter over `store`, seeded with an active signing key and the
    /// standing paired session [`REQUESTING_SID`], holding all the Owner
    /// holds, and the approval port it republishes through.
    fn starter(
        store: FakeGrantStore,
    ) -> (
        CodeAuthorizationStarter<FakeGrantStore>,
        Arc<RecordingOwnerApproval>,
    ) {
        seed_active_signing_key(&store);
        store
            .tx()
            .insert_browser_session(&BrowserSession {
                sid: REQUESTING_SID.to_owned(),
                ..BrowserSession::new_paired_session(
                    "Firefox on Linux".to_owned(),
                    crate::owner_scopes(),
                    Duration::hours(24),
                    Utc::now(),
                )
            })
            .unwrap();
        let owner_approval = Arc::new(RecordingOwnerApproval::default());
        let code_authorization_starter = CodeAuthorizationStarter::new(
            store,
            owner_approval.clone(),
            SERVER_ORIGIN.into(),
            Arc::new(StaleSessionCutoff::none()),
        );
        (code_authorization_starter, owner_approval)
    }

    /// Narrow [`REQUESTING_SID`]'s session in `code_authorization_starter`'s
    /// store to `scopes`.
    fn narrow_requesting_session(
        code_authorization_starter: &CodeAuthorizationStarter<FakeGrantStore>,
        scopes: &[&str],
    ) {
        assert!(code_authorization_starter
            .store
            .tx()
            .update_browser_session_scopes(REQUESTING_SID, &owned_scopes(scopes))
            .unwrap());
    }

    /// A registered client with a standing grant covering every requested
    /// scope takes the fast path: the request is parked and approved, a code
    /// is issued under the grant's authority (with its patient) and the
    /// requesting browser's session, and the Owner prompt is republished.
    #[test]
    fn a_fully_covered_registered_request_is_issued_a_code_without_a_human() {
        let store = FakeGrantStore::default();
        store
            .tx()
            .upsert_client(&client("app", &["patient/Patient.r", "openid"]))
            .unwrap();
        store
            .tx()
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
            .tx()
            .code_request_by_id("req-1")
            .unwrap()
            .expect("parked_request");
        assert_eq!(parked_request.state.status(), RequestStatus::Approved);
        assert_eq!(
            parked_request
                .state
                .approval()
                .and_then(|approval| approval.patient.as_deref()),
            Some("pat-1")
        );
        assert_eq!(parked_request.sid, REQUESTING_SID);
        assert_eq!(
            code_authorization_starter
                .store
                .tx()
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
            .tx()
            .upsert_client(&client("app", &["patient/Patient.r"]))
            .unwrap();
        store
            .tx()
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
            .tx()
            .code_request_by_id("req-1")
            .unwrap()
            .expect("parked_request");
        assert_eq!(parked_request.state.status(), RequestStatus::Denied);
        assert_eq!(
            code_authorization_starter
                .store
                .tx()
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
        store
            .tx()
            .upsert_client(&client("app", &["openid"]))
            .unwrap();
        store
            .tx()
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
            .tx()
            .code_request_by_id("req-1")
            .unwrap()
            .expect("parked_request");
        assert_eq!(parked_request.state.status(), RequestStatus::Pending);
        assert!(parked_request.pre_approved_scopes.is_empty());
        assert_eq!(owner_approval.count(), 1);
    }

    /// Trust on first use: an unknown client is parked for the Owner, and its
    /// later failures render locally (the redirect is unvouched-for), while a
    /// server-defined client with an unregistered redirect is refused
    /// outright.
    #[test]
    fn unknown_clients_park_and_untrusted_redirects_fail_locally() {
        let store = FakeGrantStore::default();
        store
            .tx()
            .upsert_client(&Client {
                redirect_uris: vec![Url::parse("https://host.example/cb").unwrap()],
                registration_source: RegistrationSource::ServerDefined,
                ..client("host", &["openid"])
            })
            .unwrap();
        let (code_authorization_starter, _) = starter(store);
        let outcome = code_authorization_starter
            .start(&request("newcomer", "openid"), ids(), Utc::now())
            .expect("parked_request for the owner");
        assert!(matches!(outcome, AuthorizeNextStep::AwaitOwner { .. }));

        let mut bad_type = request("newcomer", "openid");
        bad_type.response_type = "token";
        assert!(matches!(
            code_authorization_starter.start(&bad_type, ids(), Utc::now()),
            Err(AuthorizationStartError::LocalPage(
                AuthorizeRefusal::UnsupportedResponseType
            ))
        ));

        assert!(matches!(
            code_authorization_starter.start(&request("host", "openid"), ids(), Utc::now()),
            Err(AuthorizationStartError::LocalPage(
                AuthorizeRefusal::RedirectUriNotAllowed
            ))
        ));
    }

    /// Once the redirect is trusted, a spec'd failure goes back to the client,
    /// and a server-defined registration holds the request to its scopes.
    #[test]
    fn trusted_redirects_get_redirectable_errors_and_the_host_is_clamped() {
        let store = FakeGrantStore::default();
        store
            .tx()
            .upsert_client(&Client {
                kind: ClientKind::Public,
                redirect_uris: vec![Url::parse("https://example.com/cb").unwrap()],
                registration_source: RegistrationSource::ServerDefined,
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

    /// Without a signing key nothing is parked: the endpoint refuses up front.
    #[test]
    fn no_signing_key_refuses_before_parking() {
        let store = FakeGrantStore::default();
        let code_authorization_starter = CodeAuthorizationStarter::new(
            store,
            Arc::new(RecordingOwnerApproval::default()),
            SERVER_ORIGIN.into(),
            Arc::new(StaleSessionCutoff::none()),
        );
        assert!(matches!(
            code_authorization_starter.start(&request("app", "openid"), ids(), Utc::now()),
            Err(AuthorizationStartError::NoActiveSigningKey)
        ));
        assert!(code_authorization_starter
            .store
            .tx()
            .code_request_by_id("req-1")
            .unwrap()
            .is_none());
    }

    /// The launch contexts in a starter's store, for planting and spending
    /// launches.
    struct StoredLaunches<'a>(&'a FakeGrantStore);

    impl StoredLaunches<'_> {
        /// Plant a launch `nonce` for `client_id`, as a launch mints one.
        fn mint(
            &self,
            client_id: &str,
            nonce: String,
            now: DateTime<Utc>,
        ) -> Result<LaunchContext, AuthorizationServerError> {
            let launch_context = LaunchContext::for_client(nonce, client_id, None, now);
            self.0.tx().insert_launch_context(&launch_context)?;
            Ok(launch_context)
        }

        /// Plant a launch `nonce` any client may consume.
        fn mint_for_server_launcher(
            &self,
            nonce: String,
            now: DateTime<Utc>,
        ) -> Result<LaunchContext, AuthorizationServerError> {
            let launch_context = LaunchContext::for_server_launcher(nonce, now);
            self.0.tx().insert_launch_context(&launch_context)?;
            Ok(launch_context)
        }

        /// Consume `nonce` for `client_id`, as `/oauth/authorize` does.
        fn consume(
            &self,
            nonce: &str,
            client_id: &str,
            now: DateTime<Utc>,
        ) -> Result<Result<LaunchContext, LaunchRefusal>, AuthorizationServerError> {
            self.0.write(|tx| consume_launch(tx, nonce, client_id, now))
        }
    }

    /// The starter's store, for planting and spending launch contexts.
    fn launch_contexts_of(
        code_authorization_starter: &CodeAuthorizationStarter<FakeGrantStore>,
    ) -> StoredLaunches<'_> {
        StoredLaunches(&code_authorization_starter.store)
    }

    /// A registered client "app" with no standing grant, so every valid
    /// request parks for the Owner.
    fn registered_app_starter() -> CodeAuthorizationStarter<FakeGrantStore> {
        let store = FakeGrantStore::default();
        store
            .tx()
            .upsert_client(&client("app", &["openid"]))
            .unwrap();
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
                    AuthorizeRefusal::InvalidAudience
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
            .tx()
            .code_request_by_id("req-1")
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
                .tx()
                .code_request_by_id("req-2")
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
    ) -> Option<AuthorizeRefusal> {
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
                Some(AuthorizeRefusal::LaunchUnknown.description()),
                "{launch} is refused",
            );
            assert_eq!(
                launch_refusal_page(&code_authorization_starter, launch, now),
                Some(AuthorizeRefusal::LaunchUnknown),
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
            .mint_for_server_launcher("launch-2".to_owned(), minted_at)
            .unwrap();
        assert_eq!(
            launch_refusal_page(&code_authorization_starter, "launch-2", past_the_ttl),
            Some(AuthorizeRefusal::LaunchExpired),
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
            .mint_for_server_launcher("launch-2".to_owned(), now)
            .unwrap();
        for launch in ["launch-1", "launch-2"] {
            launch_contexts
                .consume(launch, "app", now)
                .unwrap()
                .expect("the first consume wins");
        }
        assert_eq!(
            launch_refusal_description(&code_authorization_starter, "launch-1", now),
            Some(AuthorizeRefusal::LaunchAlreadyUsed.description()),
        );
        assert_eq!(
            launch_refusal_page(&code_authorization_starter, "launch-2", now),
            Some(AuthorizeRefusal::LaunchAlreadyUsed),
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
        store
            .tx()
            .upsert_client(&client("app", &["openid"]))
            .unwrap();
        store
            .tx()
            .create_authorization_code_grant(&AuthorizationCodeGrant {
                scopes: vec!["openid".to_owned()],
                patient: Some("pat-1".to_owned()),
                ..code_grant("g1", "app")
            })
            .unwrap();
        let now = Utc::now();
        store
            .write(|tx| {
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
            .tx()
            .code_request_by_id("req-1")
            .unwrap()
            .expect("parked");
        assert_eq!(parked_request.state.status(), RequestStatus::Pending);
        assert_eq!(
            parked_request.launch_bound_patient.as_deref(),
            Some("pat-2")
        );
    }

    /// Whether the requesting browser decides a request turns on the
    /// request's approval scopes: a browser that decides consents and holds
    /// `patient/Observation.rs`, but can't create the grant and registration
    /// an approval records, can't approve a request for it, so the request is
    /// raised for the Owner.
    #[test]
    fn the_requesting_browser_decides_only_a_request_it_can_approve_as_asked() {
        let deciding = [
            "wildflower/AuthorizationRequest.ru",
            "patient/Observation.rs",
        ];
        for (extra_scopes, expected) in [
            (&[][..], false),
            (&["wildflower/Grant.c", "wildflower/Client.cu"][..], true),
        ] {
            let store = FakeGrantStore::default();
            store
                .tx()
                .upsert_client(&client("app", &["patient/Observation.rs"]))
                .unwrap();
            let (code_authorization_starter, _) = starter(store);
            let session_token_grant = Grant::parse(deciding.iter().chain(extra_scopes));
            let outcome = code_authorization_starter
                .start(
                    &AuthorizeRequest {
                        session_token_grant: &session_token_grant,
                        can_decide_consents: true,
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
                .tx()
                .code_request_by_id("req-1")
                .unwrap(),
            None
        );
        assert_eq!(owner_approval.count(), 0);

        let outcome = code_authorization_starter
            .start(
                &AuthorizeRequest {
                    can_decide_consents: true,
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
            .tx()
            .upsert_client(&client(
                "app",
                &["patient/Patient.r", "patient/Observation.r", "openid"],
            ))
            .unwrap();
        store
            .tx()
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
    /// limited page, once its launch is spent, before the fast path and the
    /// Owner: nothing is issued or raised.
    #[test]
    fn a_request_its_session_falls_short_of_waits_on_the_limited_page() {
        let (code_authorization_starter, owner_approval) = starter(covered_app_store());
        let now = Utc::now();
        launch_contexts_of(&code_authorization_starter)
            .mint("app", "launch-1".to_owned(), now)
            .unwrap();
        narrow_requesting_session(&code_authorization_starter, &["patient/Patient.rs"]);
        let outcome = code_authorization_starter
            .start(
                &AuthorizeRequest {
                    launch: Some("launch-1"),
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
            .tx()
            .code_request_by_id("req-1")
            .unwrap()
            .expect("parked");
        assert_eq!(
            parked_request.state.status(),
            RequestStatus::AwaitingLimitedPage
        );
        assert_eq!(parked_request.launch.as_deref(), Some("launch-1"));
        assert_eq!(
            code_authorization_starter
                .store
                .tx()
                .authorization_code_by_request_id("req-1")
                .unwrap(),
            None
        );
        assert_eq!(owner_approval.count(), 0);
        assert_eq!(
            code_authorization_starter
                .store
                .tx()
                .owner_prompt(Utc::now())
                .unwrap(),
            None
        );
    }

    /// Parking for the limited page asks the start limit, before the launch
    /// is spent: refused, nothing is parked and the launch is left unspent.
    #[test]
    fn parking_for_the_limited_page_asks_the_start_limit() {
        let (code_authorization_starter, owner_approval) = starter(covered_app_store());
        let now = Utc::now();
        launch_contexts_of(&code_authorization_starter)
            .mint("app", "launch-1".to_owned(), now)
            .unwrap();
        narrow_requesting_session(&code_authorization_starter, &["patient/Patient.rs"]);
        let refused = code_authorization_starter.start(
            &AuthorizeRequest {
                launch: Some("launch-1"),
                may_raise_for_owner: &|| false,
                ..request("app", COVERED_SCOPES)
            },
            ids(),
            now,
        );
        assert!(matches!(
            refused,
            Err(AuthorizationStartError::StartLimited)
        ));
        assert_eq!(
            code_authorization_starter
                .store
                .tx()
                .code_request_by_id("req-1")
                .unwrap(),
            None
        );
        assert!(launch_contexts_of(&code_authorization_starter)
            .consume("launch-1", "app", now)
            .unwrap()
            .is_ok());
        assert_eq!(owner_approval.count(), 0);
    }

    /// Start `COVERED_SCOPES` for "app" in a session holding only
    /// `patient/Patient.rs`, so it waits on the limited page as "req-1".
    fn park_for_the_limited_page(
        code_authorization_starter: &CodeAuthorizationStarter<FakeGrantStore>,
    ) {
        narrow_requesting_session(code_authorization_starter, &["patient/Patient.rs"]);
        let outcome = code_authorization_starter
            .start(&request("app", COVERED_SCOPES), ids(), Utc::now())
            .expect("starts");
        assert!(matches!(
            outcome,
            AuthorizeNextStep::ConfirmSessionShortfall { .. }
        ));
    }

    /// Going on past the limited page takes the fast path the start would
    /// have taken: the request goes on past the page and is approved, and the code
    /// carries only what the requesting session holds.
    #[test]
    fn continuing_past_the_shortfall_takes_the_fast_path() {
        let (code_authorization_starter, owner_approval) = starter(covered_app_store());
        park_for_the_limited_page(&code_authorization_starter);
        let outcome = code_authorization_starter
            .continue_past_session_shortfall(
                "req-1",
                REQUESTING_SID,
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
            .tx()
            .code_request_by_id("req-1")
            .unwrap()
            .expect("present");
        assert_eq!(request.state.status(), RequestStatus::Approved);
        assert_eq!(
            code_authorization_starter
                .store
                .tx()
                .authorization_code_by_request_id("req-1")
                .unwrap()
                .expect("the code")
                .granted_scopes,
            ["patient/Patient.r", "openid"],
            "the requesting session holds only patient/Patient.rs"
        );
        assert_eq!(owner_approval.count(), 1);
    }

    /// When the standing grant "g1" for "app" was last used, as stored.
    fn grant_last_used_at(
        code_authorization_starter: &CodeAuthorizationStarter<FakeGrantStore>,
    ) -> Option<DateTime<Utc>> {
        code_authorization_starter
            .store
            .tx()
            .grant_by_client_and_redirect("app", &Url::parse("https://example.com/cb").unwrap())
            .unwrap()
            .expect("the standing grant")
            .last_used_at
    }

    /// A code issued under the standing grant stamps the grant used, at
    /// `/oauth/authorize` and at the limited page's Continue. Parking for the
    /// limited page issues nothing and stamps nothing.
    #[test]
    fn a_code_issued_under_the_standing_grant_stamps_it_used() {
        let (code_authorization_starter, _) = starter(covered_app_store());
        let started_at = Utc::now();
        code_authorization_starter
            .start(&request("app", COVERED_SCOPES), ids(), started_at)
            .expect("starts");
        assert_eq!(
            grant_last_used_at(&code_authorization_starter),
            Some(started_at)
        );

        let (code_authorization_starter, _) = starter(covered_app_store());
        park_for_the_limited_page(&code_authorization_starter);
        assert_eq!(grant_last_used_at(&code_authorization_starter), None);
        let continued_at = Utc::now();
        code_authorization_starter
            .continue_past_session_shortfall(
                "req-1",
                REQUESTING_SID,
                "the-code".to_owned(),
                continued_at,
            )
            .expect("continues");
        assert_eq!(
            grant_last_used_at(&code_authorization_starter),
            Some(continued_at)
        );
    }

    /// A grant that covers only some of the requested scopes issues no code,
    /// so the request waits for the Owner and the grant stays unused.
    #[test]
    fn a_partially_covering_grant_is_not_stamped_used() {
        let store = FakeGrantStore::default();
        store
            .tx()
            .upsert_client(&client("app", &["patient/Patient.r", "openid"]))
            .unwrap();
        store
            .tx()
            .create_authorization_code_grant(&AuthorizationCodeGrant {
                scopes: vec!["openid".to_owned()],
                ..code_grant("g1", "app")
            })
            .unwrap();
        let (code_authorization_starter, _) = starter(store);
        let outcome = code_authorization_starter
            .start(
                &request("app", "patient/Patient.r openid"),
                ids(),
                Utc::now(),
            )
            .expect("starts");
        assert!(matches!(outcome, AuthorizeNextStep::AwaitOwner { .. }));
        assert_eq!(grant_last_used_at(&code_authorization_starter), None);
    }

    /// With no standing grant, going on raises the request for the Owner, with
    /// its expiry restarted, and asks no start limit: the request spent from
    /// it when it parked.
    #[test]
    fn continuing_without_a_standing_grant_raises_for_the_owner() {
        let store = FakeGrantStore::default();
        store
            .tx()
            .upsert_client(&client(
                "app",
                &["patient/Patient.r", "patient/Observation.r", "openid"],
            ))
            .unwrap();
        let (code_authorization_starter, owner_approval) = starter(store);
        park_for_the_limited_page(&code_authorization_starter);

        let continued_at = Utc::now() + Duration::minutes(4);
        let outcome = code_authorization_starter
            .continue_past_session_shortfall(
                "req-1",
                REQUESTING_SID,
                "the-code".to_owned(),
                continued_at,
            )
            .expect("continues");
        assert_eq!(
            outcome,
            AuthorizeNextStep::AwaitOwner {
                request_id: "req-1".to_owned(),
                decidable_in_requesting_browser: false,
            }
        );
        assert_eq!(
            code_authorization_starter
                .store
                .tx()
                .code_request_by_id("req-1")
                .unwrap()
                .expect("present")
                .expires_at,
            continued_at + AUTHORIZATION_REQUEST_TTL,
            "the Owner gets the request with a fresh five minutes"
        );
        assert_eq!(owner_approval.count(), 1);
        assert!(matches!(
            code_authorization_starter
                .store
                .tx()
                .owner_prompt(Utc::now())
                .unwrap(),
            Some(crate::domain::owner_prompt::OwnerPrompt::AuthorizationCode { .. })
        ));
    }

    /// Once a session has gone on past the limited page for a client, its
    /// later requests for that client skip the page, even asking for more
    /// than before, and a request raised for the Owner that way asks the start
    /// limit; another session, or the same session for another client, still
    /// stops at it.
    #[test]
    fn a_session_gone_on_for_a_client_skips_the_limited_page_for_it() {
        let (code_authorization_starter, _) = starter(covered_app_store());
        narrow_requesting_session(&code_authorization_starter, &["patient/Patient.rs"]);
        code_authorization_starter
            .store
            .tx()
            .insert_browser_session(&BrowserSession {
                sid: "another-sid".to_owned(),
                ..BrowserSession::new_paired_session(
                    "Safari on iOS".to_owned(),
                    owned_scopes(&["patient/Patient.rs"]),
                    Duration::hours(24),
                    Utc::now(),
                )
            })
            .unwrap();
        let start = |request_id: &str, sid: &str, client_id: &str, scope: &str| {
            code_authorization_starter
                .start(
                    &AuthorizeRequest {
                        sid,
                        ..request(client_id, scope)
                    },
                    FreshIds {
                        request_id: request_id.to_owned(),
                        code: format!("{request_id}-code"),
                    },
                    Utc::now(),
                )
                .expect("starts")
        };
        let waits = |outcome: &AuthorizeNextStep| {
            matches!(outcome, AuthorizeNextStep::ConfirmSessionShortfall { .. })
        };

        assert!(waits(&start(
            "req-1",
            REQUESTING_SID,
            "app",
            COVERED_SCOPES
        )));
        code_authorization_starter
            .continue_past_session_shortfall(
                "req-1",
                REQUESTING_SID,
                "the-code".to_owned(),
                Utc::now(),
            )
            .expect("continues");

        let again = start(
            "req-2",
            REQUESTING_SID,
            "app",
            "patient/Patient.r patient/Observation.r patient/Condition.r openid",
        );
        assert!(
            matches!(again, AuthorizeNextStep::AwaitOwner { .. }),
            "{again:?}"
        );
        assert!(
            code_authorization_starter
                .store
                .tx()
                .code_request_by_id("req-2")
                .unwrap()
                .expect("parked")
                .state
                .status()
                == RequestStatus::Pending
        );
        assert!(
            matches!(
                code_authorization_starter.start(
                    &AuthorizeRequest {
                        may_raise_for_owner: &|| false,
                        ..request("app", "patient/Condition.r")
                    },
                    FreshIds {
                        request_id: "req-limited".to_owned(),
                        code: "unused".to_owned(),
                    },
                    Utc::now(),
                ),
                Err(AuthorizationStartError::StartLimited)
            ),
            "skipping the page, the request is raised for the Owner and asks the limit"
        );
        assert!(waits(&start("req-3", "another-sid", "app", COVERED_SCOPES)));
        assert!(waits(&start(
            "req-4",
            REQUESTING_SID,
            "other-app",
            COVERED_SCOPES
        )));
        assert!(!code_authorization_starter
            .store
            .tx()
            .is_session_shortfall_acknowledged_for_client(REQUESTING_SID, "other-app")
            .unwrap());
    }

    /// What the session holds is read from its row: once the Owner has
    /// widened it to cover the request, the next start takes the fast path,
    /// whatever the session's token still says.
    #[test]
    fn a_session_widened_since_no_longer_waits_on_the_limited_page() {
        let (code_authorization_starter, _) = starter(covered_app_store());
        park_for_the_limited_page(&code_authorization_starter);
        narrow_requesting_session(
            &code_authorization_starter,
            &["patient/Patient.rs", "patient/Observation.rs"],
        );
        let narrow_token_grant = Grant::parse(["patient/Patient.rs"]);
        let outcome = code_authorization_starter
            .start(
                &AuthorizeRequest {
                    session_token_grant: &narrow_token_grant,
                    ..request("app", COVERED_SCOPES)
                },
                FreshIds {
                    request_id: "req-2".to_owned(),
                    code: "the-code".to_owned(),
                },
                Utc::now(),
            )
            .expect("starts");
        assert!(
            matches!(outcome, AuthorizeNextStep::RedirectToClient { .. }),
            "{outcome:?}"
        );
    }

    /// A request that reviews the shortfall (`prompt=consent`) stops at the
    /// limited page although the session went on past it for the client
    /// before; one the session holds all of goes on as usual.
    #[test]
    fn reviewing_the_shortfall_shows_the_limited_page_after_a_continue() {
        let (code_authorization_starter, _) = starter(covered_app_store());
        park_for_the_limited_page(&code_authorization_starter);
        code_authorization_starter
            .continue_past_session_shortfall(
                "req-1",
                REQUESTING_SID,
                "the-code".to_owned(),
                Utc::now(),
            )
            .expect("continues");
        let start = |request_id: &str, scope: &str| {
            code_authorization_starter
                .start(
                    &AuthorizeRequest {
                        reviews_session_shortfall: true,
                        ..request("app", scope)
                    },
                    FreshIds {
                        request_id: request_id.to_owned(),
                        code: format!("{request_id}-code"),
                    },
                    Utc::now(),
                )
                .expect("starts")
        };
        assert_eq!(
            start("req-2", COVERED_SCOPES),
            AuthorizeNextStep::ConfirmSessionShortfall {
                request_id: "req-2".to_owned()
            }
        );
        assert!(matches!(
            start("req-3", "patient/Patient.r openid"),
            AuthorizeNextStep::RedirectToClient { .. }
        ));
    }

    /// A client disabled since the request parked ends it at Continue: the
    /// request is denied and the app is sent `access_denied`, saying why.
    #[test]
    fn continuing_for_a_client_disabled_since_denies_the_request() {
        let (code_authorization_starter, owner_approval) = starter(covered_app_store());
        park_for_the_limited_page(&code_authorization_starter);
        code_authorization_starter
            .store
            .tx()
            .set_client_disabled("app", Some(Utc::now()))
            .unwrap();
        let outcome = code_authorization_starter.continue_past_session_shortfall(
            "req-1",
            REQUESTING_SID,
            "the-code".to_owned(),
            Utc::now(),
        );
        assert!(
            matches!(
                outcome,
                Err(AuthorizationStartError::Redirectable {
                    error: OAuthErrorCode::AccessDenied,
                    description: "The supplied client_id has been disabled.",
                    ref client_state,
                    ..
                }) if client_state == "xyz"
            ),
            "{outcome:?}"
        );
        assert_eq!(
            code_authorization_starter
                .store
                .tx()
                .code_request_by_id("req-1")
                .unwrap()
                .expect("present")
                .state
                .status(),
            RequestStatus::Denied
        );
        assert_eq!(owner_approval.count(), 0);
    }

    /// Without a signing key, going on refuses up front, as the start does,
    /// and the request still waits on its limited page.
    #[test]
    fn continuing_without_a_signing_key_refuses_before_acknowledging() {
        let store = FakeGrantStore::default();
        store
            .tx()
            .insert_code_request(&CodeRequest::new(
                NewCodeRequestArgs {
                    ttl: AUTHORIZATION_REQUEST_TTL,
                    awaits_limited_page: true,
                    ..fixture_code_args("req-1", "client", owned_scopes(&["read"]))
                },
                Utc::now(),
            ))
            .unwrap();
        let code_authorization_starter = CodeAuthorizationStarter::new(
            store,
            Arc::new(RecordingOwnerApproval::default()),
            SERVER_ORIGIN.into(),
            Arc::new(StaleSessionCutoff::none()),
        );
        assert!(matches!(
            code_authorization_starter.continue_past_session_shortfall(
                "req-1",
                FIXTURE_SID,
                "the-code".to_owned(),
                Utc::now(),
            ),
            Err(AuthorizationStartError::NoActiveSigningKey)
        ));
        assert_eq!(
            code_authorization_starter
                .store
                .tx()
                .code_request_by_id("req-1")
                .unwrap()
                .expect("present")
                .state,
            CodeRequestState::AwaitingLimitedPage
        );
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
                "the-code".to_owned(),
                Utc::now(),
            )
            .expect("its own session goes on");
        assert!(not_found(
            code_authorization_starter.continue_past_session_shortfall(
                "req-1",
                REQUESTING_SID,
                "another-code".to_owned(),
                Utc::now(),
            )
        ));
    }
}
