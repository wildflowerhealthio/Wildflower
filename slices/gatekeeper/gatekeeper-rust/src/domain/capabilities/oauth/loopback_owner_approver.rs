//! [`LoopbackOwnerApprover`] — the host's native loopback dialog as a second
//! approver of a parked `/authorize` request.
//!
//! When the hosted owner UI (`wildflower-react`, served from a public origin)
//! logs in against this server over **direct loopback**, the person at the
//! keyboard is the Owner, so rather than send them to the in-app consent page
//! the host raises a native dialog (the
//! [`LoopbackConsentPrompt`] port). The request is parked exactly as any other
//! (the browser still polls for it, and it still appears in the Owner UI); the
//! dialog's answer is applied through the same code-flow approval the Owner
//! UI's consent prompt uses, with two differences:
//!
//!  - the approver is the host Owner, so the approval delegates the requested
//!    scopes the host owner grant covers (`host_owner_scopes`), and the dialog
//!    itself is the acknowledgement of a new or widened registration;
//!  - the approval is [`ApprovalMemory::AskEveryTime`]: the client is
//!    registered, but no standing grant is recorded, so every loopback login
//!    asks again.
//!
//! Whichever surface decides first wins: a decision on a request that is no
//! longer pending changes nothing
//! ([`AlreadyDecided`](LoopbackDecision::AlreadyDecided)).

use std::sync::Arc;

use chrono::{DateTime, Utc};
use scopes_rust::Grant;

use crate::domain::authority::within_approver_grant;
use crate::domain::capabilities::access::consents::{
    approve_oauth_consent, deny_oauth_consent, load_pending_code_request, ApprovalContext,
    ApprovalMemory, ApproveOAuthConsentInput, ConsentOutcome,
};
use crate::domain::client_registration::{ClientRegistrationVerdict, RegistrationClassifier};
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::domain::GatekeeperStore;
use crate::ports::{
    LoopbackConsentAnswer, LoopbackConsentPrompt, LoopbackConsentRequest,
    LoopbackRegistrationNotice, PendingConsentPublisher, SelfHostedRedirectResolver,
};

/// The `client_id` the hosted owner UI presents — the one client whose
/// direct-loopback logins raise the host's dialog.
pub(crate) const HOSTED_OWNER_UI_CLIENT_ID: &str = "wildflower-react";

/// Whether a parked `/authorize` request is put to the host's loopback dialog:
/// only a **direct-loopback** request (no `Forwarded` header — a tunnel-relayed
/// caller is remote, whoever sits at the machine) presenting the hosted owner
/// UI's `client_id`. Every other request is decided in the Owner UI alone.
///
/// The `client_id` is only a claim — any local process can present it. What
/// makes the dialog safe is that it names the redirect origin to the Owner, who
/// is at the machine; the same trade-off as trusting a client on first use.
pub(crate) fn asks_loopback_dialog(is_direct_loopback: bool, client_id: &str) -> bool {
    is_direct_loopback && client_id == HOSTED_OWNER_UI_CLIENT_ID
}

/// What applying the dialog's answer did.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum LoopbackDecision {
    /// Approved: a code was issued, the client registered, no grant recorded.
    Approved,
    /// Denied — the Owner rejected it, or nothing requested was within the host
    /// owner grant.
    Denied,
    /// The host showed no dialog; the request is still the Owner UI's to decide.
    LeftForOwnerUi,
    /// The request was no longer pending (the Owner UI decided it first, or it
    /// expired), so the answer changed nothing.
    AlreadyDecided,
}

/// Put a parked request to the host's loopback dialog and apply the answer.
/// Public (no principal: the answer comes from the host's own UI), so its only
/// powers are those two operations on the parked code-flow request. Generic over
/// the store port so it's unit-testable against the fake; the binding
/// instantiates it over the concrete `SqliteGatekeeperStore`.
pub(crate) struct LoopbackOwnerApprover<S: GatekeeperStore> {
    store: S,
    publisher: Arc<dyn PendingConsentPublisher>,
    prompt: Arc<dyn LoopbackConsentPrompt>,
    host_owner_grant: Grant,
    self_hosted_redirects: Arc<dyn SelfHostedRedirectResolver>,
    first_party_client_id: Arc<str>,
}

impl<S: GatekeeperStore> LoopbackOwnerApprover<S> {
    /// Build the approver over the store, the popup republish port, the host's
    /// dialog, the host Owner's grant (the approving authority), the
    /// self-hosted redirect seam, and the first-party `client_id` — all lifted
    /// from the state.
    pub(crate) fn new(
        store: S,
        publisher: Arc<dyn PendingConsentPublisher>,
        prompt: Arc<dyn LoopbackConsentPrompt>,
        host_owner_grant: Grant,
        self_hosted_redirects: Arc<dyn SelfHostedRedirectResolver>,
        first_party_client_id: Arc<str>,
    ) -> Self {
        LoopbackOwnerApprover {
            store,
            publisher,
            prompt,
            host_owner_grant,
            self_hosted_redirects,
            first_party_client_id,
        }
    }

    /// What the dialog shows for the parked request `request_id`, or `None`
    /// when it is no longer a pending code-flow request (decided or expired —
    /// nothing to ask). `served_origin` is the origin `/authorize` was served
    /// on, so the registration notice agrees with the Owner UI's.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] on a store failure.
    fn consent_request(
        &self,
        request_id: &str,
        served_origin: &str,
    ) -> Result<Option<LoopbackConsentRequest>, GatekeeperError> {
        let pending_request = match load_pending_code_request(&self.store, request_id) {
            Ok(pending_request) => pending_request,
            Err(GatekeeperError::OAuthConsentNotFound { .. }) => return Ok(None),
            Err(error) => return Err(error),
        };
        let request = pending_request.request();
        let requested_redirect_uri = pending_request.redirect_uri();
        let maybe_existing_client = self.store.client_by_id(&request.client_id)?;
        let registration_verdict = self.classifier(served_origin).classify(
            &request.client_id,
            maybe_existing_client.as_ref(),
            requested_redirect_uri,
            &request.requested_scopes,
        );
        Ok(Some(LoopbackConsentRequest {
            request_id: request.id.clone(),
            client_id: request.client_id.clone(),
            redirect_origin: requested_redirect_uri.origin().ascii_serialization(),
            registration_notice: registration_notice(&registration_verdict),
            requested_scopes: request.requested_scopes.clone(),
            expires_at: request.expires_at,
        }))
    }

    /// Show the host's dialog for `request` and wait for the Owner's answer.
    /// Blocks — call it off the async runtime.
    fn ask(&self, request: &LoopbackConsentRequest) -> LoopbackConsentAnswer {
        self.prompt.ask(request)
    }

    /// Apply the Owner's `answer` to the parked request `request_id`.
    ///
    /// - [`Approve`](LoopbackConsentAnswer::Approve) runs the code-flow
    ///   approval with the host Owner as approver: the requested scopes the host
    ///   owner grant covers are delegated, the registration is acknowledged,
    ///   and [no standing grant](ApprovalMemory::AskEveryTime) is recorded.
    /// - [`Reject`](LoopbackConsentAnswer::Reject) denies it.
    /// - [`Abstain`](LoopbackConsentAnswer::Abstain) leaves it pending.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] on a store failure.
    fn decide(
        &self,
        request_id: &str,
        answer: LoopbackConsentAnswer,
        served_origin: &str,
        generate_code: impl FnOnce() -> String,
        now: DateTime<Utc>,
    ) -> Result<LoopbackDecision, GatekeeperError> {
        let outcome = match answer {
            LoopbackConsentAnswer::Abstain => return Ok(LoopbackDecision::LeftForOwnerUi),
            LoopbackConsentAnswer::Reject => {
                deny_oauth_consent(&self.store, self.publisher.as_ref(), request_id)
                    .map(|()| LoopbackDecision::Denied)
            }
            LoopbackConsentAnswer::Approve => {
                self.approve(request_id, served_origin, generate_code, now)
            }
        };
        match outcome {
            Err(GatekeeperError::OAuthConsentNotFound { .. }) => {
                Ok(LoopbackDecision::AlreadyDecided)
            }
            other => other,
        }
    }

    /// The approval half of [`decide`](Self::decide).
    fn approve(
        &self,
        request_id: &str,
        served_origin: &str,
        generate_code: impl FnOnce() -> String,
        now: DateTime<Utc>,
    ) -> Result<LoopbackDecision, GatekeeperError> {
        let pending_request = load_pending_code_request(&self.store, request_id)?;
        let input = ApproveOAuthConsentInput {
            owner_approved_scopes: within_approver_grant(
                &pending_request.request().requested_scopes,
                &self.host_owner_grant,
            ),
            patient: None,
            // The dialog names the app, its redirect origin, and the
            // registration notice: answering it is the acknowledgement.
            acknowledged_registration: true,
        };
        let outcome = approve_oauth_consent(
            &self.store,
            self.publisher.as_ref(),
            request_id,
            input,
            generate_code,
            &ApprovalContext {
                approver_grant: &self.host_owner_grant,
                classifier: &self.classifier(served_origin),
                first_party_client_id: &self.first_party_client_id,
                memory: ApprovalMemory::AskEveryTime,
                now,
            },
        )?;
        Ok(match outcome {
            ConsentOutcome::Approved { .. } => LoopbackDecision::Approved,
            ConsentOutcome::Denied => LoopbackDecision::Denied,
        })
    }

    fn classifier<'a>(&'a self, served_origin: &'a str) -> RegistrationClassifier<'a> {
        RegistrationClassifier {
            self_hosted_redirects: self.self_hosted_redirects.as_ref(),
            served_origin,
        }
    }
}

impl<S: GatekeeperStore + Send + Sync + 'static> LoopbackOwnerApprover<S> {
    /// Put the parked request `request_id` to the dialog and apply the answer:
    /// the whole flow, which `/authorize` runs in the background after it has
    /// sent the browser to the wait page.
    ///
    /// The store and the dialog both block, so each step runs on a blocking
    /// worker. The dialog is given until the request expires; after that the
    /// silence is applied as a reject (a no-op once the request has expired). A
    /// dialog still on screen then stays until dismissed, and its answer is
    /// discarded.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] on a store failure or a worker that
    /// died.
    pub(crate) async fn ask_and_decide(
        self: Arc<Self>,
        request_id: String,
        served_origin: String,
        generate_code: fn() -> String,
    ) -> Result<LoopbackDecision, GatekeeperError> {
        let (id, origin) = (request_id.clone(), served_origin.clone());
        let Some(consent_request) = self
            .on_blocking_worker(move |approver| approver.consent_request(&id, &origin))
            .await??
        else {
            return Ok(LoopbackDecision::AlreadyDecided);
        };
        let until_expiry = (consent_request.expires_at - Utc::now())
            .to_std()
            .unwrap_or_default();
        let asking = self.on_blocking_worker(move |approver| approver.ask(&consent_request));
        let answer = tokio::time::timeout(until_expiry, asking)
            .await
            .unwrap_or(Ok(LoopbackConsentAnswer::Reject))?;
        self.on_blocking_worker(move |approver| {
            approver.decide(
                &request_id,
                answer,
                &served_origin,
                generate_code,
                Utc::now(),
            )
        })
        .await?
    }

    /// Run one blocking `step` of [`ask_and_decide`](Self::ask_and_decide) on
    /// tokio's blocking pool.
    async fn on_blocking_worker<T: Send + 'static>(
        self: &Arc<Self>,
        step: impl FnOnce(&Self) -> T + Send + 'static,
    ) -> Result<T, GatekeeperError> {
        let approver = Arc::clone(self);
        tokio::task::spawn_blocking(move || step(&approver))
            .await
            .map_err(|error| {
                GatekeeperError::infrastructure("loopback dialog worker failed", error)
            })
    }
}

/// The dialog's rendering of a registration verdict. A verdict that widens
/// only the scopes (the redirect is known) is still a known app: the approval
/// never delegates past the host owner grant, so the scope half has nothing
/// further to warn about.
fn registration_notice(verdict: &ClientRegistrationVerdict) -> LoopbackRegistrationNotice {
    match verdict {
        ClientRegistrationVerdict::New => LoopbackRegistrationNotice::NewApp,
        ClientRegistrationVerdict::WouldWiden {
            redirect_uri_is_new: true,
            ..
        } => LoopbackRegistrationNotice::NewAddress,
        ClientRegistrationVerdict::Registered | ClientRegistrationVerdict::WouldWiden { .. } => {
            LoopbackRegistrationNotice::KnownApp
        }
    }
}

#[cfg(test)]
mod tests {
    use chrono::Duration;
    use proptest::prelude::*;
    use url::Url;

    use super::*;
    use crate::domain::authorization_request::{AuthorizationRequest, RequestStatus};
    use crate::domain::client::RegisteredRedirectUri;
    use crate::domain::test_fake::{client, code_request, FakeGatekeeperStore, RecordingPublisher};
    use crate::ports::NoSelfHostedRedirects;

    /// The loopback served origin every test decides on.
    const SERVED_ORIGIN: &str = "http://127.0.0.1";

    /// A dialog that always gives the same answer.
    struct FixedAnswer(LoopbackConsentAnswer);

    impl LoopbackConsentPrompt for FixedAnswer {
        fn ask(&self, _request: &LoopbackConsentRequest) -> LoopbackConsentAnswer {
            self.0
        }
    }

    /// A pending `wildflower-react` login for `scopes`, redirecting to the
    /// fixtures' `https://example.com/cb`.
    fn hosted_ui_request(id: &str, scopes: &[&str]) -> AuthorizationRequest {
        AuthorizationRequest {
            client_id: HOSTED_OWNER_UI_CLIENT_ID.to_owned(),
            requested_scopes: scopes.iter().map(|s| (*s).to_owned()).collect(),
            ..code_request(
                id,
                RequestStatus::Pending,
                Utc::now() + Duration::minutes(5),
            )
        }
    }

    /// An approver over `store` whose host Owner holds only the Wildflower
    /// wildcard — narrower than the live host grant, so the tests can see an
    /// approval narrowed to it.
    fn approver(
        store: FakeGatekeeperStore,
        answer: LoopbackConsentAnswer,
    ) -> LoopbackOwnerApprover<FakeGatekeeperStore> {
        LoopbackOwnerApprover::new(
            store,
            Arc::new(RecordingPublisher::default()),
            Arc::new(FixedAnswer(answer)),
            Grant::parse(["wildflower/*.cruds"]),
            Arc::new(NoSelfHostedRedirects),
            crate::FIRST_PARTY_CLIENT_ID.into(),
        )
    }

    fn store_with(request: &AuthorizationRequest) -> FakeGatekeeperStore {
        let store = FakeGatekeeperStore::default();
        store.insert_authorization_request(request).unwrap();
        store
    }

    fn decide(
        approver: &LoopbackOwnerApprover<FakeGatekeeperStore>,
        answer: LoopbackConsentAnswer,
    ) -> LoopbackDecision {
        approver
            .decide(
                "req-1",
                answer,
                SERVED_ORIGIN,
                || "the-code".to_owned(),
                Utc::now(),
            )
            .expect("decides")
    }

    fn status_of(approver: &LoopbackOwnerApprover<FakeGatekeeperStore>) -> RequestStatus {
        approver
            .store
            .authorization_request_by_id("req-1")
            .unwrap()
            .expect("request")
            .status
    }

    /// The trigger: only the hosted owner UI's `client_id`, only over direct
    /// loopback. Flipping either guard alone withholds the dialog — most
    /// critically, a tunnel-relayed request never reaches it.
    #[test]
    fn only_a_direct_loopback_hosted_ui_login_asks_the_dialog() {
        assert!(asks_loopback_dialog(true, "wildflower-react"));
        assert!(!asks_loopback_dialog(false, "wildflower-react"));
        assert!(!asks_loopback_dialog(true, crate::FIRST_PARTY_CLIENT_ID));
        assert!(!asks_loopback_dialog(true, "some-smart-app"));
        assert!(!asks_loopback_dialog(true, ""));
        assert!(!asks_loopback_dialog(true, "wildflower-react "));
        assert!(!asks_loopback_dialog(true, "Wildflower-React"));
    }

    proptest! {
        /// No other `client_id`, however close, raises the dialog, and a
        /// forwarded request never does whatever its `client_id`.
        #[test]
        fn no_other_client_or_forwarded_request_asks_the_dialog(
            client_id in ".*",
            is_direct_loopback: bool,
        ) {
            let asks = asks_loopback_dialog(is_direct_loopback, &client_id);
            prop_assert_eq!(
                asks,
                is_direct_loopback && client_id == HOSTED_OWNER_UI_CLIENT_ID
            );
        }
    }

    /// The dialog's notice follows the registration verdict; a widening of the
    /// scopes alone (known redirect) is still a known app.
    #[test]
    fn the_notice_names_what_is_new_about_the_login() {
        assert_eq!(
            registration_notice(&ClientRegistrationVerdict::New),
            LoopbackRegistrationNotice::NewApp
        );
        assert_eq!(
            registration_notice(&ClientRegistrationVerdict::WouldWiden {
                redirect_uri_is_new: true,
                unregistered_requested_scopes: Vec::new(),
            }),
            LoopbackRegistrationNotice::NewAddress
        );
        assert_eq!(
            registration_notice(&ClientRegistrationVerdict::WouldWiden {
                redirect_uri_is_new: false,
                unregistered_requested_scopes: vec!["openid".to_owned()],
            }),
            LoopbackRegistrationNotice::KnownApp
        );
        assert_eq!(
            registration_notice(&ClientRegistrationVerdict::Registered),
            LoopbackRegistrationNotice::KnownApp
        );
    }

    /// A pending login is described by its client, redirect origin, notice,
    /// scopes, and expiry; a request no longer pending is not asked about.
    #[test]
    fn consent_request_describes_a_pending_login_and_skips_a_decided_one() {
        let request = hosted_ui_request("req-1", &["wildflower/*.cruds"]);
        let approver = approver(store_with(&request), LoopbackConsentAnswer::Abstain);
        assert_eq!(
            approver
                .consent_request("req-1", SERVED_ORIGIN)
                .unwrap()
                .expect("pending"),
            LoopbackConsentRequest {
                request_id: "req-1".to_owned(),
                client_id: HOSTED_OWNER_UI_CLIENT_ID.to_owned(),
                redirect_origin: "https://example.com".to_owned(),
                registration_notice: LoopbackRegistrationNotice::NewApp,
                requested_scopes: vec!["wildflower/*.cruds".to_owned()],
                expires_at: request.expires_at,
            }
        );

        approver.store.deny_authorization_request("req-1").unwrap();
        assert_eq!(
            approver.consent_request("req-1", SERVED_ORIGIN).unwrap(),
            None
        );
        assert_eq!(
            approver.consent_request("unknown", SERVED_ORIGIN).unwrap(),
            None
        );
    }

    /// Approving issues a code for the requested scopes the host owner grant
    /// covers (a resource scope outside it is dropped; non-resource scopes —
    /// identity markers, `wildflower/launch` — pass, as for any approver),
    /// registers the new client with its redirect, and records **no** standing
    /// grant.
    #[test]
    fn approve_issues_a_code_and_registers_the_client_without_a_grant() {
        let request = hosted_ui_request(
            "req-1",
            &[
                "system/*.cruds",
                "wildflower/*.cruds",
                "wildflower/launch",
                "openid",
            ],
        );
        let approver = approver(store_with(&request), LoopbackConsentAnswer::Approve);

        assert_eq!(
            decide(&approver, LoopbackConsentAnswer::Approve),
            LoopbackDecision::Approved
        );

        let code = approver
            .store
            .authorization_code_by_request_id("req-1")
            .unwrap()
            .expect("code issued");
        assert_eq!(
            code.granted_scopes,
            ["wildflower/*.cruds", "wildflower/launch", "openid"]
        );
        let registered = approver
            .store
            .client_by_id(HOSTED_OWNER_UI_CLIENT_ID)
            .unwrap()
            .expect("client registered");
        assert_eq!(
            registered.redirect_uris,
            [RegisteredRedirectUri::Absolute(
                Url::parse("https://example.com/cb").unwrap()
            )]
        );
        assert!(approver
            .store
            .grant_by_client_and_redirect(
                HOSTED_OWNER_UI_CLIENT_ID,
                &Url::parse("https://example.com/cb").unwrap(),
            )
            .unwrap()
            .is_none());
    }

    /// Approving a login for a client already registered widens nothing it
    /// doesn't need to, and still records no grant.
    #[test]
    fn approve_for_a_registered_client_records_no_grant() {
        let request = hosted_ui_request("req-1", &["wildflower/*.cruds"]);
        let store = store_with(&request);
        store
            .upsert_client(&client(HOSTED_OWNER_UI_CLIENT_ID, &["wildflower/*.cruds"]))
            .unwrap();
        let approver = approver(store, LoopbackConsentAnswer::Approve);

        assert_eq!(
            decide(&approver, LoopbackConsentAnswer::Approve),
            LoopbackDecision::Approved
        );
        assert!(approver
            .store
            .grant_by_client_and_redirect(
                HOSTED_OWNER_UI_CLIENT_ID,
                &Url::parse("https://example.com/cb").unwrap(),
            )
            .unwrap()
            .is_none());
    }

    /// A login asking for nothing the host Owner holds is denied, not issued an
    /// empty code.
    #[test]
    fn approve_with_nothing_within_the_host_grant_denies() {
        let request = hosted_ui_request("req-1", &["system/*.cruds"]);
        let approver = approver(store_with(&request), LoopbackConsentAnswer::Approve);
        assert_eq!(
            decide(&approver, LoopbackConsentAnswer::Approve),
            LoopbackDecision::Denied
        );
        assert_eq!(status_of(&approver), RequestStatus::Denied);
    }

    /// Rejecting denies the request (the wait page then sends
    /// `access_denied`) and registers nothing.
    #[test]
    fn reject_denies_and_registers_nothing() {
        let request = hosted_ui_request("req-1", &["wildflower/*.cruds"]);
        let approver = approver(store_with(&request), LoopbackConsentAnswer::Reject);
        assert_eq!(
            decide(&approver, LoopbackConsentAnswer::Reject),
            LoopbackDecision::Denied
        );
        assert_eq!(status_of(&approver), RequestStatus::Denied);
        assert!(approver
            .store
            .client_by_id(HOSTED_OWNER_UI_CLIENT_ID)
            .unwrap()
            .is_none());
    }

    /// A host without a dialog abstains: the request stays pending for the
    /// Owner UI.
    #[test]
    fn abstain_leaves_the_request_for_the_owner_ui() {
        let request = hosted_ui_request("req-1", &["wildflower/*.cruds"]);
        let approver = approver(store_with(&request), LoopbackConsentAnswer::Abstain);
        assert_eq!(
            decide(&approver, LoopbackConsentAnswer::Abstain),
            LoopbackDecision::LeftForOwnerUi
        );
        assert_eq!(status_of(&approver), RequestStatus::Pending);
    }

    /// Whichever surface decides first wins: once the Owner UI has decided
    /// (either way), neither dialog answer changes the request or issues a code.
    #[test]
    fn an_answer_after_the_owner_ui_decided_changes_nothing() {
        for (prior, settled) in [
            (LoopbackConsentAnswer::Reject, RequestStatus::Denied),
            (LoopbackConsentAnswer::Approve, RequestStatus::Approved),
        ] {
            for late in [
                LoopbackConsentAnswer::Approve,
                LoopbackConsentAnswer::Reject,
            ] {
                let request = hosted_ui_request("req-1", &["wildflower/*.cruds"]);
                let approver = approver(store_with(&request), prior);
                decide(&approver, prior);
                let code_before = approver
                    .store
                    .authorization_code_by_request_id("req-1")
                    .unwrap();

                assert_eq!(decide(&approver, late), LoopbackDecision::AlreadyDecided);
                assert_eq!(status_of(&approver), settled);
                assert_eq!(
                    approver
                        .store
                        .authorization_code_by_request_id("req-1")
                        .unwrap(),
                    code_before
                );
            }
        }
    }

    /// An answer that arrives after the request expired changes nothing.
    #[test]
    fn an_answer_after_expiry_changes_nothing() {
        let request = AuthorizationRequest {
            expires_at: Utc::now() - Duration::seconds(1),
            ..hosted_ui_request("req-1", &["wildflower/*.cruds"])
        };
        let approver = approver(store_with(&request), LoopbackConsentAnswer::Approve);
        assert_eq!(
            decide(&approver, LoopbackConsentAnswer::Approve),
            LoopbackDecision::AlreadyDecided
        );
        assert_eq!(status_of(&approver), RequestStatus::Pending);
    }

    /// `ask` hands the request to the host's dialog and returns its answer.
    #[test]
    fn ask_returns_the_dialogs_answer() {
        let request = hosted_ui_request("req-1", &["wildflower/*.cruds"]);
        let approver = approver(store_with(&request), LoopbackConsentAnswer::Reject);
        let consent_request = approver
            .consent_request("req-1", SERVED_ORIGIN)
            .unwrap()
            .expect("pending");
        assert_eq!(
            approver.ask(&consent_request),
            LoopbackConsentAnswer::Reject
        );
    }
}
