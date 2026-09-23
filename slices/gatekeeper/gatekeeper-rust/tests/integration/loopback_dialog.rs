//! The host's loopback dialog, end to end: a direct-loopback `/authorize` by the
//! hosted owner UI (`wildflower-react`) is parked as usual — the browser is sent
//! to the polling page — and the dialog, played here by a scripted fake,
//! decides it in the background. Only that login asks; a forwarded request or
//! another client never does.
//!
//! The decision lands on its own task after `/authorize` has answered, so each
//! test waits for it through the pending-consent head (the request under
//! decision is the oldest pending one, so the head leaves it exactly when it is
//! decided). These tests run on a file-backed database (see
//! `spin_up_with_loopback_prompt`), where the decision's writes wait on
//! `busy_timeout` instead of failing when they overlap other work.
//!
//! An answer that arrives after the Owner UI decided changes nothing, so it
//! leaves no event to wait on here; that ordering is pinned by the approver's
//! unit tests and the store's pending-only deny.

use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration as StdDuration;

use gatekeeper_rust::{
    LoopbackConsentAnswer, LoopbackConsentPrompt, LoopbackConsentRequest,
    LoopbackRegistrationNotice,
};

use crate::common::*;

/// The hosted owner UI's `client_id` — the one client the dialog is for.
const HOSTED_UI: &str = "wildflower-react";

/// The owner scope set the hosted owner UI requests, URL-encoded.
const OWNER_SCOPES_QUERY: &str = "system%2F*.cruds%20wildflower%2F*.cruds%20wildflower%2Flaunch";

/// How long a test waits for a background step before failing — a guard
/// against a hang, never the synchronisation itself.
const WAIT: StdDuration = StdDuration::from_secs(10);

/// A fake dialog that records every request it is shown, then answers with the
/// scripted answer once the test has released it (immediately, unless built
/// [`held`](Self::held)).
struct ScriptedDialog {
    asked: Mutex<Vec<LoopbackConsentRequest>>,
    answer: Mutex<Option<LoopbackConsentAnswer>>,
    released: Condvar,
}

impl ScriptedDialog {
    /// A dialog that answers `answer` as soon as it is shown.
    fn answering(answer: LoopbackConsentAnswer) -> Arc<Self> {
        Arc::new(ScriptedDialog {
            asked: Mutex::new(Vec::new()),
            answer: Mutex::new(Some(answer)),
            released: Condvar::new(),
        })
    }

    /// A dialog that waits on screen until [`release`](Self::release)d.
    fn held() -> Arc<Self> {
        Arc::new(ScriptedDialog {
            asked: Mutex::new(Vec::new()),
            answer: Mutex::new(None),
            released: Condvar::new(),
        })
    }

    /// Answer every waiting (and later) showing with `answer`.
    fn release(&self, answer: LoopbackConsentAnswer) {
        *self.answer.lock().expect("answer lock") = Some(answer);
        self.released.notify_all();
    }

    /// Every request the dialog has been shown, in order.
    fn shown(&self) -> Vec<LoopbackConsentRequest> {
        self.asked.lock().expect("asked lock").clone()
    }

    /// The ids of the requests the dialog has been shown, in order.
    fn shown_ids(&self) -> Vec<String> {
        self.shown()
            .into_iter()
            .map(|request| request.request_id)
            .collect()
    }

    /// Wait until the dialog has been shown `request_id`.
    async fn wait_until_shown(&self, request_id: &str) {
        let shown = async {
            while !self.shown_ids().iter().any(|id| id == request_id) {
                tokio::time::sleep(StdDuration::from_millis(5)).await;
            }
        };
        tokio::time::timeout(WAIT, shown)
            .await
            .expect("the dialog is shown the login");
    }
}

impl LoopbackConsentPrompt for ScriptedDialog {
    fn ask(&self, request: &LoopbackConsentRequest) -> LoopbackConsentAnswer {
        self.asked.lock().expect("asked lock").push(request.clone());
        let answer = self.answer.lock().expect("answer lock");
        let answer = self
            .released
            .wait_while(answer, |answer| answer.is_none())
            .expect("answer lock");
        answer.expect("released with an answer")
    }
}

/// A gatekeeper whose loopback dialog is `dialog`.
fn spin_up_with(dialog: &Arc<ScriptedDialog>) -> (Gatekeeper, String, TestDb) {
    let prompt: Arc<dyn LoopbackConsentPrompt> = dialog.clone();
    spin_up_with_loopback_prompt(prompt)
}

/// Wait until the pending request `request_id` — the oldest pending one, so
/// the popup head — has been decided: the head moves off it exactly then.
async fn wait_until_decided(db: &TestDb, request_id: &str) {
    let mut head = pending_consent_watch(db);
    let decided = async {
        loop {
            let still_head = matches!(
                &*head.borrow_and_update(),
                Some(PendingConsentHead::OAuth { id }) if id == request_id
            );
            if !still_head {
                return;
            }
            head.changed()
                .await
                .expect("pending-consent head sender alive");
        }
    };
    tokio::time::timeout(WAIT, decided)
        .await
        .expect("the dialog's answer is applied");
}

/// The stored status of `request_id`.
fn status_of(db: &TestDb, request_id: &str) -> RequestStatus {
    store_handle(db)
        .authorization_request_by_id(request_id)
        .expect("query")
        .expect("row present")
        .status
}

/// `GET /oauth/authorize` relayed by the trusted front — carrying the
/// `Forwarded` header a tunnel request arrives with.
async fn get_authorize_forwarded(router: &axum::Router, query: &str) -> axum::response::Response {
    router
        .clone()
        .oneshot(loopback_request(
            Request::get(format!("/oauth/authorize?{query}")).header(
                "forwarded",
                "host=ruth.wildflowerhealth.example;proto=https",
            ),
            Body::empty(),
        ))
        .await
        .expect("oneshot")
}

/// `GET /oauth/authorize/{id}` — what the polling page sees.
async fn poll_status(router: &axum::Router, request_id: &str) -> Value {
    let res = router
        .clone()
        .oneshot(loopback_request(
            Request::get(format!("/oauth/authorize/{request_id}")),
            Body::empty(),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    body_json(res.into_body()).await
}

/// The shared `https://app.example/cb` redirect the logins present.
fn app_redirect() -> Url {
    Url::parse("https://app.example/cb").expect("redirect url")
}

/// Approve: the browser still lands on the polling page, the dialog is shown
/// the login (client, redirect origin, the notice for a known app at a new
/// address, the scopes), and once approved the poll hands back a code that
/// redeems at `/token`. The redirect joins the client's registration, and no
/// standing grant is recorded.
#[tokio::test]
async fn an_approved_loopback_login_is_issued_a_redeemable_code_and_no_grant() {
    let dialog = ScriptedDialog::answering(LoopbackConsentAnswer::Approve);
    let (g, _host_owner_token, db) = spin_up_with(&dialog);

    let res = get_authorize(&g.router, &authorize_query(HOSTED_UI, OWNER_SCOPES_QUERY)).await;
    let request_id = parked_request_id(&res);
    wait_until_decided(&db, &request_id).await;
    assert_eq!(status_of(&db, &request_id), RequestStatus::Approved);

    let shown = dialog.shown();
    assert_eq!(shown.len(), 1);
    assert_eq!(shown[0].request_id, request_id);
    assert_eq!(shown[0].client_id, HOSTED_UI);
    assert_eq!(shown[0].redirect_origin, "https://app.example");
    // `wildflower-react` is seeded with its published redirect only, so this
    // origin is new to a known app.
    assert_eq!(
        shown[0].registration_notice,
        LoopbackRegistrationNotice::NewAddress
    );
    assert_eq!(
        shown[0].requested_scopes,
        ["system/*.cruds", "wildflower/*.cruds", "wildflower/launch"]
    );

    let status = poll_status(&g.router, &request_id).await;
    assert_eq!(status["status"], "approved");
    let redirect = Url::parse(status["redirect"].as_str().expect("redirect")).expect("url");
    let code = redirect
        .query_pairs()
        .find(|(k, _)| k == "code")
        .map(|(_, v)| v.into_owned())
        .expect("code param");
    let res = g
        .router
        .clone()
        .oneshot(loopback_request(
            Request::post("/oauth/token")
                .header("content-type", "application/x-www-form-urlencoded"),
            Body::from(format!(
                "grant_type=authorization_code&client_id={HOSTED_UI}&code={code}&\
                 code_verifier={CODE_VERIFIER}&redirect_uri=https%3A%2F%2Fapp.example%2Fcb"
            )),
        ))
        .await
        .expect("oneshot");
    assert_eq!(res.status(), StatusCode::OK);
    let token = body_json(res.into_body()).await;
    assert_eq!(
        token["scope"],
        "system/*.cruds wildflower/*.cruds wildflower/launch"
    );

    let store = store_handle(&db);
    let registered = store
        .client_by_id(HOSTED_UI)
        .expect("query")
        .expect("client row");
    assert!(registered.redirect_uris.contains(&app_redirect().into()));
    assert!(store
        .grant_by_client_and_redirect(HOSTED_UI, &app_redirect())
        .expect("query")
        .is_none());
}

/// No standing grant means no fast path: the same login again is parked and
/// put to the dialog again — now as a known app.
#[tokio::test]
async fn a_second_identical_login_asks_again() {
    let dialog = ScriptedDialog::answering(LoopbackConsentAnswer::Approve);
    let (g, _host_owner_token, db) = spin_up_with(&dialog);
    let query = authorize_query(HOSTED_UI, OWNER_SCOPES_QUERY);

    let first = parked_request_id(&get_authorize(&g.router, &query).await);
    wait_until_decided(&db, &first).await;
    let second = parked_request_id(&get_authorize(&g.router, &query).await);
    wait_until_decided(&db, &second).await;

    assert_eq!(status_of(&db, &first), RequestStatus::Approved);
    assert_eq!(status_of(&db, &second), RequestStatus::Approved);
    let shown = dialog.shown();
    assert_eq!(dialog.shown_ids(), [first, second]);
    assert_eq!(
        shown[1].registration_notice,
        LoopbackRegistrationNotice::KnownApp
    );
}

/// Reject: the request is denied and the polling page sends the browser back
/// with `access_denied`. The registration is left as it was.
#[tokio::test]
async fn a_rejected_loopback_login_is_denied() {
    let dialog = ScriptedDialog::answering(LoopbackConsentAnswer::Reject);
    let (g, _host_owner_token, db) = spin_up_with(&dialog);
    let seeded = store_handle(&db)
        .client_by_id(HOSTED_UI)
        .expect("query")
        .expect("seeded client row");

    let request_id = parked_request_id(
        &get_authorize(&g.router, &authorize_query(HOSTED_UI, OWNER_SCOPES_QUERY)).await,
    );
    wait_until_decided(&db, &request_id).await;
    assert_eq!(status_of(&db, &request_id), RequestStatus::Denied);

    let status = poll_status(&g.router, &request_id).await;
    assert_eq!(status["status"], "denied");
    assert!(status["redirect"]
        .as_str()
        .expect("redirect")
        .contains("error=access_denied"));
    assert_eq!(
        store_handle(&db)
            .client_by_id(HOSTED_UI)
            .expect("query")
            .expect("client row"),
        seeded
    );
}

/// A tunnel-relayed login and another client's login are never put to the
/// dialog: both stay pending for the Owner UI. A login that does ask goes
/// first and is held on screen while the other two arrive, so by the time it is
/// answered and decided the dialog has had every chance to be shown them too.
#[tokio::test]
async fn a_forwarded_login_or_another_client_never_asks() {
    let dialog = ScriptedDialog::held();
    let (g, _host_owner_token, db) = spin_up_with(&dialog);
    seed_client_with_redirect(&db, "other-app", "https://app.example/cb", &["openid"]);

    let asking = parked_request_id(
        &get_authorize(&g.router, &authorize_query(HOSTED_UI, OWNER_SCOPES_QUERY)).await,
    );
    let forwarded = parked_request_id(
        &get_authorize_forwarded(&g.router, &authorize_query(HOSTED_UI, OWNER_SCOPES_QUERY)).await,
    );
    let other_client =
        parked_request_id(&get_authorize(&g.router, &authorize_query("other-app", "openid")).await);
    dialog.wait_until_shown(&asking).await;
    dialog.release(LoopbackConsentAnswer::Reject);
    wait_until_decided(&db, &asking).await;

    assert_eq!(dialog.shown_ids(), std::slice::from_ref(&asking));
    assert_eq!(status_of(&db, &asking), RequestStatus::Denied);
    assert_eq!(status_of(&db, &forwarded), RequestStatus::Pending);
    assert_eq!(status_of(&db, &other_client), RequestStatus::Pending);
}
