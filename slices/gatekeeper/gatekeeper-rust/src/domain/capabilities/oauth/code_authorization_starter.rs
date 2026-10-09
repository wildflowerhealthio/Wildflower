//! [`CodeAuthorizationStarter`] — the `/oauth/authorize` flow (RFC 6749 §3.1,
//! §4.1.1; RFC 7636). Validates the request, parks it, and either issues a
//! code on the spot under a
//! [`StandingGrantCoverage`](crate::domain::authority::StandingGrantCoverage)
//! proof (the one path that issues a code with no human in the loop — named as
//! an authority so it can be audited as such) or hands it to the Owner. A
//! SMART App Launch's `aud` is checked against this server, and its `launch`
//! is consumed and carried onto the parked request.

use std::sync::Arc;

use chrono::{DateTime, Duration, Utc};
use shared_structures_rust::FHIR_R4_PATH;
use url::Url;

use super::LaunchContexts;
use crate::crypto_util::pkce::is_valid_s256_code_challenge;
use crate::domain::authority::{GrantCoverage, StandingGrantCoverage};
use crate::domain::authorization_code::PendingCodeRequest;
use crate::domain::authorization_request::StartCodeAuthorizationArgs;
use crate::domain::capabilities::writers::{CodeAuthority, RequestApprover};
use crate::domain::client::Client;
use crate::domain::client_registration::{classify_registration, PresentedClientRegistration};
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::domain::oauth_error_code::OAuthErrorCode;
use crate::domain::oauth_error_kind::OAuthErrorKind;
use crate::domain::GatekeeperStore;
use crate::ports::PendingConsentPublisher;

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
    /// The request is parked and the Owner has been asked; the user-agent
    /// polls for the decision.
    AwaitOwner { request_id: String },
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
    /// A spec'd error once `redirect_uri` is validated.
    Redirectable {
        redirect_uri: Url,
        error: OAuthErrorCode,
        client_state: String,
    },
    /// The request this flow just parked was no longer pending when the fast
    /// path approved it — an unexpected concurrent transition.
    RequestNotPending,
    Store(GatekeeperError),
}

impl From<GatekeeperError> for AuthorizationStartError {
    fn from(error: GatekeeperError) -> Self {
        AuthorizationStartError::Store(error)
    }
}

/// Start authorization-code flows. Public (no principal: the caller is the
/// user's browser), so its only power is this one operation. Generic over the
/// store port so it's unit-testable against the fake; the binding instantiates
/// it over the concrete `SqliteGatekeeperStore`.
pub(crate) struct CodeAuthorizationStarter<S: GatekeeperStore> {
    store: S,
    publisher: Arc<dyn PendingConsentPublisher>,
    first_party_client_id: Arc<str>,
    /// The server's bare origin, `https://<domain>`: an `aud` must name it or
    /// its FHIR base.
    server_origin: Arc<str>,
}

impl<S: GatekeeperStore> CodeAuthorizationStarter<S> {
    /// Build the starter over the store, the popup republish port, the
    /// first-party `client_id`, and the server's origin — all lifted from the
    /// state.
    pub(crate) fn new(
        store: S,
        publisher: Arc<dyn PendingConsentPublisher>,
        first_party_client_id: Arc<str>,
        server_origin: Arc<str>,
    ) -> Self {
        CodeAuthorizationStarter {
            store,
            publisher,
            first_party_client_id,
            server_origin,
        }
    }

    /// Validate `authorize_query` (client and redirect first, then the redirectable
    /// params), park it, and decide: a fully pre-approved request is issued a
    /// code under the standing grant's authority and sent back to the client;
    /// anything else joins the pending-consent queue.
    ///
    /// Clients other than the first-party host are trusted on first use (see
    /// [`crate::domain::client_registration`]): a request outside the
    /// registration is parked with a warning rather than rejected, never takes
    /// the fast path, and — while its redirect is untrusted — renders every
    /// failure locally rather than risk an open redirect.
    ///
    /// A declared `aud` must be this server's origin or its FHIR base. A
    /// `launch` must name an unconsumed, unexpired launch context minted for
    /// this client; it is consumed (so it never works twice) and carried onto
    /// the parked request. Either failure is `invalid_request`, the same for
    /// every reason a launch is refused. A request with no `launch` is plain
    /// OAuth. When the launch binds a patient, the fast path applies only if
    /// the standing grant names the same one; otherwise the Owner decides.
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
        let registration_is_locked = self.registration_is_locked(authorize_query.client_id);
        let maybe_existing_client =
            self.load_client(authorize_query.client_id, registration_is_locked)?;
        let requested_redirect_uri = parse_redirect_uri(authorize_query.redirect_uri)?;
        // A redirect is trustworthy only when a client we already know already
        // registered it.
        let redirect_allowlisted = maybe_existing_client
            .as_ref()
            .is_some_and(|existing_client| {
                existing_client.allows_redirect_uri(&requested_redirect_uri)
            });
        if registration_is_locked && !redirect_allowlisted {
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
        if let (true, Some(locked_client)) =
            (registration_is_locked, maybe_existing_client.as_ref())
        {
            if !locked_client.allows_scopes(&requested_scopes) {
                return Err(AuthorizationStartError::Redirectable {
                    redirect_uri: requested_redirect_uri,
                    error: OAuthErrorCode::InvalidScope,
                    client_state: authorize_query.client_state.to_owned(),
                });
            }
        }
        let registration_verdict = classify_registration(&PresentedClientRegistration {
            maybe_existing_client: maybe_existing_client.as_ref(),
            redirect_uri: &requested_redirect_uri,
            scopes: &requested_scopes,
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
                let Some(launch_context) = LaunchContexts::over(&self.store).consume(
                    launch,
                    authorize_query.client_id,
                    now,
                )?
                else {
                    tracing::warn!(
                        client_id = authorize_query.client_id,
                        "refused a launch that is unknown, consumed, expired, or for another client",
                    );
                    return Err(start_error(
                        authorize_query,
                        &requested_redirect_uri,
                        redirect_allowlisted,
                        OAuthErrorCode::InvalidRequest,
                        OAuthErrorKind::InvalidLaunch,
                    ));
                };
                Some(launch_context)
            }
        };

        // Park the request — every path from here on references it by id.
        let parked_request =
            PendingCodeRequest::new_code_authorization(StartCodeAuthorizationArgs {
                id: ids.request_id.clone(),
                client_id: authorize_query.client_id.to_owned(),
                requested_scopes,
                code_challenge: authorize_query.code_challenge.to_owned(),
                redirect_uri: requested_redirect_uri.clone(),
                client_state: authorize_query.client_state.to_owned(),
                pre_approved_scopes: coverage.pre_approved_scopes().to_vec(),
                ttl: AUTHORIZATION_REQUEST_TTL,
                launch_context,
            });
        self.store
            .insert_authorization_request(parked_request.request())?;

        if let GrantCoverage::Full(standing_grant_coverage) = coverage {
            // The fast path: the standing grant is the authority, as long as
            // its patient is one the launch admits. The insert above parked
            // this request as pending for the width of the approval, so the
            // popup head is recomputed afterwards rather than left on a
            // request the consent surface now 404s for; recomputing can only
            // publish the genuinely-pending head, never this one.
            if parked_request
                .request()
                .admits_patient(standing_grant_coverage.patient())
            {
                return self.issue_under_standing_grant(
                    &standing_grant_coverage,
                    &parked_request,
                    requested_redirect_uri,
                    authorize_query.client_state,
                    ids.code,
                    now,
                );
            }
        }

        // This request needs a human: raise the host popup (after the fast-path
        // return above, so a pre-approved request never flickers into it).
        self.publisher.republish_active();
        Ok(AuthorizeNextStep::AwaitOwner {
            request_id: ids.request_id,
        })
    }

    /// The fast path's approval: issue `code` for `parked_request` under the
    /// standing grant, recompute the popup head, and send the user-agent back
    /// to the client with the code.
    fn issue_under_standing_grant(
        &self,
        standing_grant_coverage: &StandingGrantCoverage,
        parked_request: &PendingCodeRequest,
        requested_redirect_uri: Url,
        client_state: &str,
        code: String,
        now: DateTime<Utc>,
    ) -> Result<AuthorizeNextStep, AuthorizationStartError> {
        let issued_code = RequestApprover::over(&self.store).approve_for_code(
            CodeAuthority::StandingGrant(standing_grant_coverage),
            parked_request,
            standing_grant_coverage.patient(),
            code,
            now,
        )?;
        self.publisher.republish_active();
        let Some(issued_code) = issued_code else {
            return Err(AuthorizationStartError::RequestNotPending);
        };
        Ok(AuthorizeNextStep::RedirectToClient {
            redirect_uri: requested_redirect_uri,
            code: issued_code.code,
            client_state: client_state.to_owned(),
        })
    }

    /// Whether `client_id`'s registration is locked — true only for the
    /// first-party host, the one client held to its registration rather than
    /// trusted on first use.
    fn registration_is_locked(&self, client_id: &str) -> bool {
        client_id == &*self.first_party_client_id
    }

    /// The client row named by the request, if any. A disabled client is
    /// rejected outright, as is an unknown first-party `client_id`; any other
    /// unknown `client_id` is `None` — a `New` registration verdict.
    fn load_client(
        &self,
        client_id: &str,
        registration_is_locked: bool,
    ) -> Result<Option<Client>, AuthorizationStartError> {
        let Some(client) = self.store.client_by_id(client_id)? else {
            return if registration_is_locked {
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
        if !names_this_server(aud, server_origin) {
            return Err(fail(
                OAuthErrorCode::InvalidRequest,
                OAuthErrorKind::InvalidAudience,
            ));
        }
    }
    Ok(())
}

/// Whether a SMART `aud` names this server: exactly its origin
/// (`https://<domain>`) or its FHIR base (`https://<domain>/fhir-r4`), the
/// `iss` every launch hands the app.
fn names_this_server(aud: &str, server_origin: &str) -> bool {
    aud == server_origin
        || aud
            .strip_prefix(server_origin)
            .is_some_and(|path| path == FHIR_R4_PATH)
}

/// A refusal of `authorize_query`: back to the client as `error` once its
/// redirect is trusted, else the `local` page (RFC 6749 §4.1.2.1).
fn start_error(
    authorize_query: &AuthorizeRequest<'_>,
    redirect_uri: &Url,
    redirect_trusted: bool,
    error: OAuthErrorCode,
    local: OAuthErrorKind,
) -> AuthorizationStartError {
    if redirect_trusted {
        AuthorizationStartError::Redirectable {
            redirect_uri: redirect_uri.clone(),
            error,
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
    use crate::domain::client::ClientKind;
    use crate::domain::grant::AuthorizationCodeGrant;
    use crate::domain::launch_context::{LaunchContext, LAUNCH_CONTEXT_TTL};
    use crate::domain::GatekeeperTx as _;

    use crate::domain::test_fake::{
        client, code_grant, seed_active_signing_key, FakeGatekeeperStore, RecordingPublisher,
    };

    const CHALLENGE: &str = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    const SERVER_ORIGIN: &str = "https://ruth.relay.example";

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
        }
    }

    fn ids() -> FreshIds {
        FreshIds {
            request_id: "req-1".to_owned(),
            code: "the-code".to_owned(),
        }
    }

    fn starter(
        store: FakeGatekeeperStore,
    ) -> (
        CodeAuthorizationStarter<FakeGatekeeperStore>,
        Arc<RecordingPublisher>,
    ) {
        seed_active_signing_key(&store);
        let publisher = Arc::new(RecordingPublisher::default());
        let code_authorization_starter = CodeAuthorizationStarter::new(
            store,
            publisher.clone(),
            "host".into(),
            SERVER_ORIGIN.into(),
        );
        (code_authorization_starter, publisher)
    }

    /// A registered client with a standing grant covering every requested
    /// scope takes the fast path: the request is parked_request and approved, a code
    /// is issued under the grant's authority (with its patient), and the popup
    /// head is recomputed.
    #[test]
    fn a_fully_covered_registered_request_is_issued_a_code_without_a_human() {
        let store = FakeGatekeeperStore::default();
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
        let (code_authorization_starter, publisher) = starter(store);
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
        assert_eq!(publisher.count(), 1);
    }

    /// A request outside the registration (a scope the client never
    /// registered) waits for the Owner even though the standing grant would
    /// cover it — the Owner has not seen this combination.
    #[test]
    fn a_request_outside_the_registration_waits_for_the_owner() {
        let store = FakeGatekeeperStore::default();
        store.upsert_client(&client("app", &["openid"])).unwrap();
        store
            .create_authorization_code_grant(&AuthorizationCodeGrant {
                scopes: vec!["patient/*.cruds".to_owned(), "openid".to_owned()],
                ..code_grant("g1", "app")
            })
            .unwrap();
        let (code_authorization_starter, publisher) = starter(store);
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
                request_id: "req-1".to_owned()
            }
        );
        let parked_request = code_authorization_starter
            .store
            .authorization_request_by_id("req-1")
            .unwrap()
            .expect("parked_request");
        assert_eq!(parked_request.status, RequestStatus::Pending);
        assert!(parked_request.pre_approved_scopes.is_empty());
        assert_eq!(publisher.count(), 1);
    }

    /// Trust on first use: an unknown non-first-party client is parked_request for the
    /// Owner, and its later failures render locally (the redirect is
    /// unvouched-for), while the first-party host with an unregistered
    /// redirect is refused outright.
    #[test]
    fn unknown_clients_park_and_untrusted_redirects_fail_locally() {
        let (code_authorization_starter, _) = starter(FakeGatekeeperStore::default());
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
    /// and the first-party host is held to its scope allowlist.
    #[test]
    fn trusted_redirects_get_redirectable_errors_and_the_host_is_clamped() {
        let store = FakeGatekeeperStore::default();
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
                ..
            })
        ));
    }

    /// Without a signing key nothing is parked_request: the endpoint refuses up front.
    #[test]
    fn no_signing_key_refuses_before_parking() {
        let store = FakeGatekeeperStore::default();
        let code_authorization_starter = CodeAuthorizationStarter::new(
            store,
            Arc::new(RecordingPublisher::default()),
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
        code_authorization_starter: &CodeAuthorizationStarter<FakeGatekeeperStore>,
    ) -> LaunchContexts<'_, FakeGatekeeperStore> {
        LaunchContexts::over(&code_authorization_starter.store)
    }

    /// A registered client "app" with no standing grant, so every valid
    /// request parks for the Owner.
    fn registered_app_starter() -> CodeAuthorizationStarter<FakeGatekeeperStore> {
        let store = FakeGatekeeperStore::default();
        store.upsert_client(&client("app", &["openid"])).unwrap();
        starter(store).0
    }

    /// A declared `aud` is accepted when it is exactly this server's origin or
    /// its FHIR base, and refused as `invalid_request` otherwise — back to a
    /// trusted redirect, or as the local page while the redirect is untrusted.
    #[test]
    fn aud_must_name_this_server() {
        let code_authorization_starter = registered_app_starter();
        for accepted in [
            "https://ruth.relay.example",
            "https://ruth.relay.example/fhir-r4",
        ] {
            let authorize_query = AuthorizeRequest {
                aud: Some(accepted),
                ..request("app", "openid")
            };
            assert!(
                matches!(
                    code_authorization_starter.start(&authorize_query, ids(), Utc::now()),
                    Ok(AuthorizeNextStep::AwaitOwner { .. })
                ),
                "{accepted} is this server",
            );
        }
        for refused in [
            "https://ruth.relay.example/",
            "https://ruth.relay.example/fhir-r4/",
            "https://ruth.relay.example/fhir-r5",
            "https://ruth.relay.example.evil/fhir-r4",
            "http://ruth.relay.example/fhir-r4",
            "https://other.relay.example/fhir-r4",
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
    /// request; presenting it again is refused.
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

    /// A launch minted for another client, a forged one, and an expired one are
    /// all the same `invalid_request`; the other client's launch is left for
    /// its own client to consume. No `launch` at all is plain OAuth.
    #[test]
    fn a_launch_for_another_client_forged_or_expired_is_refused() {
        let code_authorization_starter = registered_app_starter();
        let now = Utc::now();
        let launch_contexts = launch_contexts_of(&code_authorization_starter);
        launch_contexts
            .mint("other-app", "for-other-app".to_owned(), now)
            .unwrap();
        launch_contexts
            .mint("app", "expired".to_owned(), now - LAUNCH_CONTEXT_TTL)
            .unwrap();
        for launch in ["for-other-app", "forged", "expired"] {
            let authorize_query = AuthorizeRequest {
                launch: Some(launch),
                ..request("app", "openid")
            };
            assert!(
                matches!(
                    code_authorization_starter.start(&authorize_query, ids(), now),
                    Err(AuthorizationStartError::Redirectable {
                        error: OAuthErrorCode::InvalidRequest,
                        ..
                    })
                ),
                "{launch} is refused",
            );
            let untrusted_query = AuthorizeRequest {
                launch: Some(launch),
                ..request("newcomer", "openid")
            };
            assert!(matches!(
                code_authorization_starter.start(&untrusted_query, ids(), now),
                Err(AuthorizationStartError::LocalPage(
                    OAuthErrorKind::InvalidLaunch
                ))
            ));
        }
        assert!(
            launch_contexts
                .consume("for-other-app", "other-app", now)
                .unwrap()
                .is_some(),
            "a mismatched client doesn't spend the launch"
        );
        assert!(matches!(
            code_authorization_starter.start(&request("app", "openid"), ids(), now),
            Ok(AuthorizeNextStep::AwaitOwner { .. })
        ));
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
            aud: Some("https://other.relay.example/fhir-r4"),
            ..request("app", "openid")
        };
        assert!(code_authorization_starter
            .start(&wrong_aud, ids(), now)
            .is_err());
        assert!(launch_contexts_of(&code_authorization_starter)
            .consume("launch-1", "app", now)
            .unwrap()
            .is_some());
    }

    /// When the launch binds a patient, a standing grant for a different
    /// patient doesn't take the fast path: the Owner decides, and the request
    /// carries the launch's patient.
    #[test]
    fn a_launch_bound_patient_the_grant_does_not_name_waits_for_the_owner() {
        let store = FakeGatekeeperStore::default();
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
                request_id: "req-1".to_owned()
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
}
