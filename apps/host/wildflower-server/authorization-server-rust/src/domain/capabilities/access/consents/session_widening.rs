//! A session widening's consent prompt, keyed by its id:
//! [`ConsentReader::session_widening_consent`] and [`ConsentDecider`]'s
//! `approve_session_widening` / `deny_session_widening`. An approval obtains a
//! [`DelegatedScopes`] proof, the Owner's ticks clamped to what the browser
//! asked for (untick only) and to the approver's own grant, and hands it to
//! the [`RequestApprover`], which approves the widening and widens its
//! browser session in the same scope. A widening records no grant: the
//! limited page's poll collects the wider session token.

use chrono::{DateTime, Utc};

use super::{ConsentDecider, ConsentOutcome, ConsentReader, SessionWideningConsentView};
use crate::domain::authority::{ApprovableScopes, DelegatedScopes};
use crate::domain::authorization_request::session_widening::SessionWideningRequest;
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::capabilities::writers::{RequestApprover, SessionWideningOutcome};
use crate::domain::grant_store::{AuthorizationRequestsTx, ClientsTx as _};
use crate::domain::GrantStore;

impl<S: GrantStore> ConsentReader<S> {
    /// Load the pending session widening `id` for its consent card, with the
    /// app's name resolved, the scopes the card's ticks start from, and the
    /// approval scopes the reader lacks.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::SessionWideningNotFound`] when `id` names
    /// no pending, unexpired widening; a store failure.
    pub(crate) fn session_widening_consent(
        &self,
        id: &str,
        now: DateTime<Utc>,
    ) -> Result<SessionWideningConsentView, AuthorizationServerError> {
        let (request, maybe_existing_client) = self.store.read(|tx| {
            let request = load_pending_session_widening(tx, id, now)?;
            let maybe_existing_client = tx.client_by_id(&request.client_id)?;
            Ok::<_, AuthorizationServerError>((request, maybe_existing_client))
        })?;
        let client_name = maybe_existing_client.map_or_else(
            || request.client_id.clone(),
            |existing_client| existing_client.name,
        );
        let approvable = ApprovableScopes::for_session_widening(&request.requested_scopes);
        Ok(SessionWideningConsentView {
            starting_scopes: approvable.delegable_scopes(&self.reader_grant),
            missing_approval_scopes: approvable.missing_approval_scopes(&self.reader_grant),
            request,
            client_name,
        })
    }
}

impl<S: GrantStore> ConsentDecider<S> {
    /// Approve the session widening `id` with the `owner_approved_scopes`,
    /// clamped to what the browser asked for and to the approver's own grant,
    /// widen its browser session by them, and republish the Owner prompt. An
    /// approval that grants nothing, or of a widening whose session has ended
    /// since, is applied as a **deny**.
    ///
    /// # Errors
    ///
    /// [`InsufficientScope`](AuthorizationServerError::InsufficientScope) when
    /// the approver can't decide requests, and
    /// [`InsufficientApproverScope`](AuthorizationServerError::InsufficientApproverScope)
    /// for a ticked scope beyond the approver's own grant, both writing
    /// nothing; [`SessionWideningNotFound`](AuthorizationServerError::SessionWideningNotFound)
    /// when `id` names no pending widening, or another surface decided it
    /// first.
    pub(crate) fn approve_session_widening(
        &self,
        id: &str,
        owner_approved_scopes: Vec<String>,
        now: DateTime<Utc>,
    ) -> Result<ConsentOutcome, AuthorizationServerError> {
        self.decide_and_republish(|tx| {
            let request = load_pending_session_widening(tx, id, now)?;
            let Some(delegated_scopes) = DelegatedScopes::clamp(
                &self.approver_grant,
                owner_approved_scopes,
                &ApprovableScopes::for_session_widening(&request.requested_scopes),
            )?
            else {
                deny_session_widening(tx, &request, now)?;
                return Ok(ConsentOutcome::Denied { redirect: None });
            };
            match RequestApprover::within(tx).approve_session_widening(
                &delegated_scopes,
                &request,
                &self.stale_session_cutoff,
                now,
            )? {
                SessionWideningOutcome::Widened => Ok(ConsentOutcome::Approved { redirect: None }),
                SessionWideningOutcome::BrowserSessionEnded => {
                    Ok(ConsentOutcome::Denied { redirect: None })
                }
                SessionWideningOutcome::RequestNotPending => Err(widening_not_found(id)),
            }
        })
    }

    /// Deny the session widening `id`, leaving its session as it was, and
    /// republish the Owner prompt.
    ///
    /// # Errors
    ///
    /// [`AuthorizationServerError::SessionWideningNotFound`] when `id` names
    /// no pending widening.
    pub(crate) fn deny_session_widening(
        &self,
        id: &str,
        now: DateTime<Utc>,
    ) -> Result<(), AuthorizationServerError> {
        self.decide_and_republish(|tx| {
            let request = load_pending_session_widening(tx, id, now)?;
            deny_session_widening(tx, &request, now)
        })
    }
}

/// The session widening `id`, pending at `now`. Anything else is not found.
fn load_pending_session_widening(
    tx: &mut impl AuthorizationRequestsTx,
    id: &str,
    now: DateTime<Utc>,
) -> Result<SessionWideningRequest, AuthorizationServerError> {
    tx.session_widening_request_by_id(id)?
        .filter(|request| request.is_pending_at(now))
        .ok_or_else(|| widening_not_found(id))
}

/// Deny the session widening `request`, as read, at `now`, in the caller's
/// write scope `tx`: an explicit deny, or an approval that grants nothing. It
/// lands only on a widening still pending; otherwise it is not found.
fn deny_session_widening(
    tx: &mut impl AuthorizationRequestsTx,
    request: &SessionWideningRequest,
    now: DateTime<Utc>,
) -> Result<(), AuthorizationServerError> {
    let denied = request
        .to_denied(now)
        .map_err(|_| widening_not_found(&request.id))?;
    if tx.replace_session_widening_request(request, &denied)? {
        Ok(())
    } else {
        Err(widening_not_found(&request.id))
    }
}

/// The session widening `id` is not (or no longer) pending.
fn widening_not_found(id: &str) -> AuthorizationServerError {
    AuthorizationServerError::SessionWideningNotFound { id: id.to_owned() }
}

#[cfg(test)]
mod tests {
    use crate::domain::browser_session::StaleSessionCutoff;
    use std::sync::Arc;

    use chrono::Duration;
    use wildflowerhealthio_scopes::Grant;

    use super::*;
    use crate::domain::authorization_request::polled::PolledState;
    use crate::domain::authorization_request::session_widening::{
        NewSessionWideningRequestArgs, SessionWideningApproval,
    };
    use crate::domain::browser_session::BrowserSession;
    use crate::domain::grant_store::*;
    use crate::domain::test_fake::{client, owned_scopes, FakeGrantStore, RecordingOwnerApproval};

    /// A store holding the app `app`, the paired session `sid-1` holding
    /// `wildflower/launch`, gone on past its limited page for `app` and
    /// `other-app`, and the pending widening `widen-1` of it, asking for
    /// `wildflower/Apps.r` and `patient/Patient.rs`.
    fn store() -> FakeGrantStore {
        let store = FakeGrantStore::default();
        store
            .tx()
            .upsert_client(&client("app", &["openid"]))
            .unwrap();
        store
            .tx()
            .insert_browser_session(&BrowserSession {
                sid: "sid-1".to_owned(),
                ..BrowserSession::new_paired_session(
                    "Firefox on Linux".to_owned(),
                    owned_scopes(&["wildflower/launch"]),
                    Duration::hours(24),
                    Utc::now(),
                )
            })
            .unwrap();
        for client_id in ["app", "other-app"] {
            store
                .tx()
                .record_session_shortfall_acknowledgement("sid-1", client_id)
                .unwrap();
        }
        store
            .tx()
            .insert_session_widening_request(&SessionWideningRequest::new(
                NewSessionWideningRequestArgs {
                    id: "widen-1".to_owned(),
                    sid: "sid-1".to_owned(),
                    client_id: "app".to_owned(),
                    browser_name: "Firefox on Linux".to_owned(),
                    requested_scopes: owned_scopes(&["wildflower/Apps.r", "patient/Patient.rs"]),
                    ttl: Duration::minutes(5),
                },
                Utc::now(),
            ))
            .unwrap();
        store
    }

    /// A decider over `store` approving as one holding `approver_scopes`.
    fn decider(store: &FakeGrantStore, approver_scopes: &[&str]) -> ConsentDecider<FakeGrantStore> {
        ConsentDecider::new(
            store.clone(),
            Arc::new(RecordingOwnerApproval::default()),
            Grant::parse(approver_scopes.iter().copied()),
            Arc::new(StaleSessionCutoff::none()),
        )
    }

    /// A decider over `store` approving as the Owner.
    fn owner(store: &FakeGrantStore) -> ConsentDecider<FakeGrantStore> {
        ConsentDecider::new(
            store.clone(),
            Arc::new(RecordingOwnerApproval::default()),
            Grant::parse(crate::owner_scopes()),
            Arc::new(StaleSessionCutoff::none()),
        )
    }

    /// The scopes session `sid-1` holds, as stored.
    fn session_scopes(store: &FakeGrantStore) -> Vec<String> {
        store
            .tx()
            .browser_session_by_sid("sid-1")
            .unwrap()
            .expect("stored")
            .scopes
    }

    /// The widening `widen-1`, as stored.
    fn stored(store: &FakeGrantStore) -> SessionWideningRequest {
        store
            .tx()
            .session_widening_request_by_id("widen-1")
            .unwrap()
            .expect("stored")
    }

    /// The card reads the browser, the app and the scopes asked for, ticked
    /// as far as the reader may pass them on.
    #[test]
    fn the_card_reads_the_widening_and_what_the_reader_may_tick() {
        let store = store();
        let reader = ConsentReader::new(
            store.clone(),
            Grant::parse(["wildflower/AuthorizationRequest.ru", "wildflower/*.cruds"]),
        );
        let view = reader
            .session_widening_consent("widen-1", Utc::now())
            .expect("reads");
        assert_eq!(view.request, stored(&store));
        assert_eq!(view.client_name, "app display name");
        assert_eq!(view.starting_scopes, ["wildflower/Apps.r"]);
        assert_eq!(view.missing_approval_scopes, Vec::<String>::new());
    }

    /// Approving widens the session by what the Owner left ticked, never by
    /// anything the browser didn't ask for, keeps its `sid` and expiry, and
    /// forgets every client the session went on past its limited page for.
    #[test]
    fn approving_widens_the_session_by_the_ticks_and_forgets_the_continues() {
        let store = store();
        let before = store.tx().browser_session_by_sid("sid-1").unwrap().unwrap();
        let outcome = owner(&store)
            .approve_session_widening(
                "widen-1",
                owned_scopes(&["wildflower/Apps.r", "system/Observation.rs"]),
                Utc::now(),
            )
            .expect("approves");
        assert_eq!(outcome, ConsentOutcome::Approved { redirect: None });
        assert_eq!(
            stored(&store).state,
            PolledState::Approved(SessionWideningApproval {
                granted_scopes: owned_scopes(&["wildflower/Apps.r"]),
            })
        );
        let after = store.tx().browser_session_by_sid("sid-1").unwrap().unwrap();
        assert_eq!(
            after,
            BrowserSession {
                scopes: owned_scopes(&["wildflower/launch", "wildflower/Apps.r"]),
                ..before
            }
        );
        for client_id in ["app", "other-app"] {
            assert!(!store
                .tx()
                .is_session_shortfall_acknowledged_for_client("sid-1", client_id)
                .unwrap());
        }
    }

    /// Unticking everything, or declining, leaves the session and its
    /// remembered Continues as they were.
    #[test]
    fn a_decline_leaves_the_session_as_it_was() {
        for untick_everything in [true, false] {
            let store = store();
            let owner = owner(&store);
            if untick_everything {
                assert_eq!(
                    owner.approve_session_widening("widen-1", Vec::new(), Utc::now()),
                    Ok(ConsentOutcome::Denied { redirect: None })
                );
            } else {
                owner
                    .deny_session_widening("widen-1", Utc::now())
                    .expect("denies");
            }
            assert_eq!(stored(&store).state, PolledState::Denied);
            assert_eq!(session_scopes(&store), ["wildflower/launch"]);
            assert!(store
                .tx()
                .is_session_shortfall_acknowledged_for_client("sid-1", "app")
                .unwrap());
            assert_eq!(
                owner.deny_session_widening("widen-1", Utc::now()),
                Err(AuthorizationServerError::SessionWideningNotFound {
                    id: "widen-1".to_owned()
                })
            );
        }
    }

    /// An approver can't widen a session by what it doesn't hold itself, and
    /// one that can't decide requests can't approve at all; neither writes
    /// anything.
    #[test]
    fn an_approver_widens_by_no_more_than_it_holds() {
        let store = store();
        assert_eq!(
            decider(
                &store,
                &["wildflower/AuthorizationRequest.u", "wildflower/Apps.r"]
            )
            .approve_session_widening(
                "widen-1",
                owned_scopes(&["wildflower/Apps.r", "patient/Patient.rs"]),
                Utc::now(),
            ),
            Err(AuthorizationServerError::InsufficientApproverScope {
                approver_missing_scopes: owned_scopes(&["patient/Patient.rs"]),
            })
        );
        assert_eq!(
            decider(&store, &["wildflower/Apps.r"]).approve_session_widening(
                "widen-1",
                owned_scopes(&["wildflower/Apps.r"]),
                Utc::now(),
            ),
            Err(AuthorizationServerError::InsufficientScope {
                missing_scopes: owned_scopes(&["wildflower/AuthorizationRequest.u"]),
            })
        );
        assert_eq!(stored(&store).state, PolledState::Pending);
        assert_eq!(session_scopes(&store), ["wildflower/launch"]);
    }

    /// A widening whose session has ended is denied rather than approved.
    #[test]
    fn a_widening_of_an_ended_session_is_denied() {
        let store = store();
        store
            .tx()
            .revoke_browser_session("sid-1", Utc::now())
            .unwrap();
        assert_eq!(
            owner(&store).approve_session_widening(
                "widen-1",
                owned_scopes(&["wildflower/Apps.r"]),
                Utc::now(),
            ),
            Ok(ConsentOutcome::Denied { redirect: None })
        );
        assert_eq!(stored(&store).state, PolledState::Denied);
        assert_eq!(session_scopes(&store), ["wildflower/launch"]);
    }
}
