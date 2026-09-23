//! [`CodeAuthorizationStarter`] — the `/oauth/authorize` flow (RFC 6749 §3.1,
//! §4.1.1; RFC 7636). Validates the request, parks it, and either issues a
//! code on the spot under a
//! [`StandingGrantCoverage`](crate::domain::authority::StandingGrantCoverage)
//! proof (the one path that issues a code with no human in the loop — named as
//! an authority so it can be audited as such) or hands it to the Owner.

use std::sync::Arc;

use chrono::{DateTime, Duration, Utc};
use url::Url;

use crate::crypto_util::pkce::is_valid_s256_code_challenge;
use crate::domain::authority::GrantCoverage;
use crate::domain::authorization_code::PendingCodeRequest;
use crate::domain::authorization_request::{AuthorizationRequest, StartCodeAuthorizationArgs};
use crate::domain::capabilities::writers::{CodeAuthority, RequestApprover};
use crate::domain::client::Client;
use crate::domain::client_registration::RegistrationClassifier;
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::domain::oauth_error_code::OAuthErrorCode;
use crate::domain::oauth_error_kind::OAuthErrorKind;
use crate::domain::GatekeeperStore;
use crate::ports::{PendingConsentPublisher, SelfHostedRedirectResolver};

/// Lifetime of a pending authorization request waiting for Owner approval.
pub(crate) const AUTHORIZATION_REQUEST_TTL: Duration = Duration::minutes(5);

/// The RFC 6749 §4.1.1 + RFC 7636 request, as presented.
pub(crate) struct AuthorizeRequest<'a> {
    pub(crate) response_type: &'a str,
    pub(crate) code_challenge_method: &'a str,
    pub(crate) client_id: &'a str,
    pub(crate) scope: &'a str,
    pub(crate) code_challenge: &'a str,
    pub(crate) redirect_uri: &'a str,
    pub(crate) client_state: &'a str,
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
    redirects: Arc<dyn SelfHostedRedirectResolver>,
    first_party_client_id: Arc<str>,
}

impl<S: GatekeeperStore> CodeAuthorizationStarter<S> {
    /// Build the starter over the store, the popup republish port, the
    /// self-hosted redirect seam, and the first-party `client_id` — all lifted
    /// from the state.
    pub(crate) fn new(
        store: S,
        publisher: Arc<dyn PendingConsentPublisher>,
        redirects: Arc<dyn SelfHostedRedirectResolver>,
        first_party_client_id: Arc<str>,
    ) -> Self {
        CodeAuthorizationStarter {
            store,
            publisher,
            redirects,
            first_party_client_id,
        }
    }

    /// Validate `request` (client and redirect first, then the redirectable
    /// params), park it, and decide: a fully pre-approved request is issued a
    /// code under the standing grant's authority and sent back to the client;
    /// anything else joins the pending-consent queue.
    ///
    /// Clients other than the first-party host are trusted on first use (see
    /// [`crate::domain::client_registration`]): a request outside the
    /// registration is parked with a warning rather than rejected, never takes
    /// the fast path, and — while its redirect is untrusted — renders every
    /// failure locally rather than risk an open redirect. `served_origin` is the
    /// base an app-relative redirect entry resolves against.
    ///
    /// # Errors
    ///
    /// See [`AuthorizationStartError`].
    pub(crate) fn start(
        &self,
        request: &AuthorizeRequest<'_>,
        served_origin: &str,
        ids: FreshIds,
        now: DateTime<Utc>,
    ) -> Result<AuthorizeNextStep, AuthorizationStartError> {
        if !self.store.has_active_signing_key()? {
            return Err(AuthorizationStartError::NoActiveSigningKey);
        }
        let classifier = RegistrationClassifier {
            redirects: self.redirects.as_ref(),
            served_origin,
        };
        let registration_is_locked = self.registration_is_locked(request.client_id);
        let client = self.load_client(request.client_id, registration_is_locked)?;
        let redirect_uri = parse_redirect_uri(request.redirect_uri)?;
        // A redirect is trustworthy only when a client we already know already
        // registered it.
        let redirect_allowlisted = client
            .as_ref()
            .is_some_and(|client| classifier.redirect_is_allowlisted(client, &redirect_uri));
        if registration_is_locked && !redirect_allowlisted {
            return Err(AuthorizationStartError::LocalPage(
                OAuthErrorKind::RedirectUriNotAllowed,
            ));
        }
        validate_code_params(request, &redirect_uri, redirect_allowlisted)?;
        let requested_scopes: Vec<String> = request
            .scope
            .split_whitespace()
            .map(str::to_string)
            .collect();
        // Only the first-party host is held to its allowlist here; every other
        // client's unregistered scope becomes part of its registration verdict.
        if let (true, Some(host)) = (registration_is_locked, client.as_ref()) {
            if !host.allows_scopes(&requested_scopes) {
                return Err(AuthorizationStartError::Redirectable {
                    redirect_uri,
                    error: OAuthErrorCode::InvalidScope,
                    client_state: request.client_state.to_owned(),
                });
            }
        }
        let registration = classifier.classify(
            request.client_id,
            client.as_ref(),
            &redirect_uri,
            &requested_scopes,
        );
        let coverage = GrantCoverage::resolve(
            &self.store,
            &registration,
            request.client_id,
            &redirect_uri,
            &requested_scopes,
        )?;

        // Park the request — every path from here on references it by id.
        let parked = PendingCodeRequest {
            request: AuthorizationRequest::new_code_authorization(StartCodeAuthorizationArgs {
                id: ids.request_id.clone(),
                client_id: request.client_id.to_owned(),
                requested_scopes,
                code_challenge: request.code_challenge.to_owned(),
                redirect_uri: redirect_uri.clone(),
                client_state: request.client_state.to_owned(),
                pre_approved_scopes: coverage.pre_approved_scopes().to_vec(),
                ttl: AUTHORIZATION_REQUEST_TTL,
            }),
            redirect_uri: redirect_uri.clone(),
            code_challenge: request.code_challenge.to_owned(),
        };
        self.store.insert_authorization_request(&parked.request)?;

        if let GrantCoverage::Full(standing) = coverage {
            // The fast path: the standing grant is the authority. The insert
            // above parked this request as pending for the width of the
            // approval, so the popup head is recomputed afterwards rather than
            // left on a request the consent surface now 404s for; recomputing
            // can only publish the genuinely-pending head, never this one.
            let issued = RequestApprover::over(&self.store).approve_for_code(
                CodeAuthority::StandingGrant(&standing),
                &parked,
                standing.patient(),
                ids.code,
                now,
            )?;
            self.publisher.republish_active();
            let Some(issued) = issued else {
                return Err(AuthorizationStartError::RequestNotPending);
            };
            return Ok(AuthorizeNextStep::RedirectToClient {
                redirect_uri,
                code: issued.code,
                client_state: request.client_state.to_owned(),
            });
        }

        // This request needs a human: raise the host popup (after the fast-path
        // return above, so a pre-approved request never flickers into it).
        self.publisher.republish_active();
        Ok(AuthorizeNextStep::AwaitOwner {
            request_id: ids.request_id,
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

/// The response type and PKCE challenge — spec'd errors delivered back to the
/// client only once the redirect is trusted, else as a local page.
fn validate_code_params(
    request: &AuthorizeRequest<'_>,
    redirect_uri: &Url,
    redirect_trusted: bool,
) -> Result<(), AuthorizationStartError> {
    let fail = |error: OAuthErrorCode, local: OAuthErrorKind| {
        if redirect_trusted {
            AuthorizationStartError::Redirectable {
                redirect_uri: redirect_uri.clone(),
                error,
                client_state: request.client_state.to_owned(),
            }
        } else {
            AuthorizationStartError::LocalPage(local)
        }
    };
    // Only the authorization-code grant is implemented (RFC 6749 §4.1.2.1).
    if request.response_type != "code" {
        return Err(fail(
            OAuthErrorCode::UnsupportedResponseType,
            OAuthErrorKind::UnsupportedResponseType,
        ));
    }
    // Only S256 PKCE is supported; anything else is `invalid_request` (RFC
    // 7636 §4.4.1), as is a malformed challenge.
    if request.code_challenge_method != "S256" {
        return Err(fail(
            OAuthErrorCode::InvalidRequest,
            OAuthErrorKind::UnsupportedCodeChallengeMethod,
        ));
    }
    if !is_valid_s256_code_challenge(request.code_challenge) {
        return Err(fail(
            OAuthErrorCode::InvalidRequest,
            OAuthErrorKind::InvalidCodeChallenge,
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {

    use super::*;
    use crate::domain::authorization_request::RequestStatus;
    use crate::domain::client::{ClientKind, RegisteredRedirectUri};
    use crate::domain::grant::AuthorizationCodeGrant;

    use crate::domain::test_fake::{
        client, code_grant, seed_active_signing_key, FakeGatekeeperStore, RecordingPublisher,
    };
    use crate::ports::NoSelfHostedRedirects;

    const CHALLENGE: &str = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

    fn request<'a>(client_id: &'a str, scope: &'a str) -> AuthorizeRequest<'a> {
        AuthorizeRequest {
            response_type: "code",
            code_challenge_method: "S256",
            client_id,
            scope,
            code_challenge: CHALLENGE,
            redirect_uri: "https://example.com/cb",
            client_state: "xyz",
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
        let starter = CodeAuthorizationStarter::new(
            store,
            publisher.clone(),
            Arc::new(NoSelfHostedRedirects),
            "host".into(),
        );
        (starter, publisher)
    }

    /// A registered client with a standing grant covering every requested
    /// scope takes the fast path: the request is parked and approved, a code
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
        let (starter, publisher) = starter(store);
        let outcome = starter
            .start(
                &request("app", "patient/Patient.r openid"),
                "http://127.0.0.1",
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
        let parked = starter
            .store
            .authorization_request_by_id("req-1")
            .unwrap()
            .expect("parked");
        assert_eq!(parked.status, RequestStatus::Approved);
        assert_eq!(parked.patient.as_deref(), Some("pat-1"));
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
        let (starter, publisher) = starter(store);
        let outcome = starter
            .start(
                &request("app", "patient/Patient.r openid"),
                "http://127.0.0.1",
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
        let parked = starter
            .store
            .authorization_request_by_id("req-1")
            .unwrap()
            .expect("parked");
        assert_eq!(parked.status, RequestStatus::Pending);
        assert!(parked.pre_approved_scopes.is_empty());
        assert_eq!(publisher.count(), 1);
    }

    /// Trust on first use: an unknown non-first-party client is parked for the
    /// Owner, and its later failures render locally (the redirect is
    /// unvouched-for), while the first-party host with an unregistered
    /// redirect is refused outright.
    #[test]
    fn unknown_clients_park_and_untrusted_redirects_fail_locally() {
        let (starter, _) = starter(FakeGatekeeperStore::default());
        let outcome = starter
            .start(
                &request("newcomer", "openid"),
                "http://127.0.0.1",
                ids(),
                Utc::now(),
            )
            .expect("parked for the owner");
        assert!(matches!(outcome, AuthorizeNextStep::AwaitOwner { .. }));

        let mut bad_type = request("newcomer", "openid");
        bad_type.response_type = "token";
        assert!(matches!(
            starter.start(&bad_type, "http://127.0.0.1", ids(), Utc::now()),
            Err(AuthorizationStartError::LocalPage(
                OAuthErrorKind::UnsupportedResponseType
            ))
        ));

        assert!(matches!(
            starter.start(
                &request("host", "openid"),
                "http://127.0.0.1",
                ids(),
                Utc::now()
            ),
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
                redirect_uris: vec![RegisteredRedirectUri::Absolute(
                    Url::parse("https://example.com/cb").unwrap(),
                )],
                ..client("host", &["openid"])
            })
            .unwrap();
        let (starter, _) = starter(store);
        let mut bad_type = request("host", "openid");
        bad_type.response_type = "token";
        assert!(matches!(
            starter.start(&bad_type, "http://127.0.0.1", ids(), Utc::now()),
            Err(AuthorizationStartError::Redirectable {
                error: OAuthErrorCode::UnsupportedResponseType,
                ..
            })
        ));
        assert!(matches!(
            starter.start(
                &request("host", "openid patient/Patient.r"),
                "http://127.0.0.1",
                ids(),
                Utc::now()
            ),
            Err(AuthorizationStartError::Redirectable {
                error: OAuthErrorCode::InvalidScope,
                ..
            })
        ));
    }

    /// Without a signing key nothing is parked: the endpoint refuses up front.
    #[test]
    fn no_signing_key_refuses_before_parking() {
        let store = FakeGatekeeperStore::default();
        let starter = CodeAuthorizationStarter::new(
            store,
            Arc::new(RecordingPublisher::default()),
            Arc::new(NoSelfHostedRedirects),
            "host".into(),
        );
        assert!(matches!(
            starter.start(
                &request("app", "openid"),
                "http://127.0.0.1",
                ids(),
                Utc::now()
            ),
            Err(AuthorizationStartError::NoActiveSigningKey)
        ));
        assert!(starter
            .store
            .authorization_request_by_id("req-1")
            .unwrap()
            .is_none());
    }
}
