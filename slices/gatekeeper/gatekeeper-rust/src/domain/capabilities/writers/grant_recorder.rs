//! [`GrantRecorder`] — the writer that establishes or cumulatively widens a
//! standing grant, and (for a client trusted on first use) the client
//! registration that grant justifies. Both writes demand a [`DelegatedScopes`]
//! proof: a grant row and a widened `allowed_scopes` only ever carry scopes an
//! approver was entitled to delegate.

use chrono::{DateTime, Utc};
use scopes_rust::widened_scopes;
use url::Url;
use uuid::Uuid;

use crate::domain::authority::DelegatedScopes;
use crate::domain::client::{AllowedGrantType, Client, ClientKind, RegisteredRedirectUri};
use crate::domain::client_registration::ClientRegistration;
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::domain::grant::{AuthorizationCodeGrant, CumulativeConsent, DeviceGrant};
use crate::domain::{GatekeeperStore, GatekeeperTx};

/// Record standing grants. A borrowed view over the store; the gate is the
/// [`DelegatedScopes`] each method takes.
pub(crate) struct GrantRecorder<'a, S: GatekeeperStore> {
    store: &'a S,
}

impl<'a, S: GatekeeperStore> GrantRecorder<'a, S> {
    /// A writer over `store`.
    pub(crate) fn over(store: &'a S) -> Self {
        GrantRecorder { store }
    }

    /// Register (or widen) the client and insert or cumulatively update the
    /// standing authorization-code grant for `(client_id, redirect_uri)`, all
    /// inside one `BEGIN IMMEDIATE` transaction: widen the `clients` row by the
    /// `registration_to_widen` verdict (if any), then read the standing grant — if present, fold the
    /// re-approval in via [`CumulativeConsent::absorb_reapproval`] and write it
    /// back; otherwise mint a fresh grant. `BEGIN IMMEDIATE` takes the write lock
    /// before the read, so two concurrent approvals serialise at the read rather
    /// than both reading the pre-merge row and one losing its scope union — and
    /// the registration lands with the grant it justifies or not at all.
    ///
    /// `registration_to_widen` is the verdict the Owner acknowledged, for a
    /// client trusted on first use: the `clients` row is created when absent,
    /// otherwise widened in place, and the approved redirect joins its
    /// allowlist exactly when the verdict found it new. `None` — the
    /// first-party host, whose registration an approval never widens — writes
    /// no `clients` row at all.
    ///
    /// The grant (and any widened registration) records exactly the proof's
    /// scopes, so a scope the Owner pruned is never added to either.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] on a store failure; the transaction
    /// rolls back.
    pub(crate) fn record_code_grant(
        &self,
        client_id: &str,
        redirect_uri: &Url,
        delegated_scopes: &DelegatedScopes,
        patient: Option<&str>,
        now: DateTime<Utc>,
        registration_to_widen: Option<&ClientRegistration>,
    ) -> Result<(), GatekeeperError> {
        let delegated = delegated_scopes.scopes();
        self.store.immediate_transaction(|tx| {
            if let Some(registration_verdict) = registration_to_widen {
                let row = match tx.client_by_id(client_id)? {
                    Some(existing_client) => widen_registration(
                        existing_client,
                        redirect_uri,
                        delegated,
                        registration_verdict.redirect_uri_is_new(),
                    ),
                    None => new_registration(client_id, redirect_uri, delegated, now),
                };
                // `upsert_client` updates in place, preserving `registered_at` and
                // any admin `disabled_at` — a widening never resurrects a disabled
                // client.
                tx.upsert_client(&row)?;
            }
            match tx.grant_by_client_and_redirect(client_id, redirect_uri)? {
                Some(mut grant) => {
                    grant.absorb_reapproval(delegated, patient, now);
                    tx.update_authorization_code_grant(&grant)
                }
                None => tx.create_authorization_code_grant(&AuthorizationCodeGrant {
                    id: Uuid::new_v4().to_string(),
                    client_id: client_id.to_owned(),
                    scopes: delegated.to_vec(),
                    granted_at: now,
                    last_used_at: None,
                    patient: patient.map(str::to_owned),
                    redirect_uri: redirect_uri.clone(),
                }),
            }
        })
    }

    /// Insert or cumulatively update the standing device grant for
    /// `(client_id, device_name)` — the same read-merge-write-under-
    /// `BEGIN IMMEDIATE` shape as [`record_code_grant`](Self::record_code_grant),
    /// keyed on the device name. Device consent never touches the registration.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] on a store failure; the transaction
    /// rolls back.
    pub(crate) fn record_device_grant(
        &self,
        client_id: &str,
        device_name: &str,
        delegated_scopes: &DelegatedScopes,
        patient: Option<&str>,
        now: DateTime<Utc>,
    ) -> Result<(), GatekeeperError> {
        let delegated = delegated_scopes.scopes();
        self.store.immediate_transaction(|tx| {
            match tx.device_grant_by_client_and_device_name(client_id, device_name)? {
                Some(mut grant) => {
                    grant.absorb_reapproval(delegated, patient, now);
                    tx.update_device_grant(&grant)
                }
                None => tx.create_device_grant(&DeviceGrant {
                    id: Uuid::new_v4().to_string(),
                    client_id: client_id.to_owned(),
                    scopes: delegated.to_vec(),
                    granted_at: now,
                    last_used_at: None,
                    patient: patient.map(str::to_owned),
                    device_name: device_name.to_owned(),
                }),
            }
        })
    }
}

/// The `clients` row a first approval of an unregistered client creates: a
/// public client named after its own `client_id` (there is no registrar to have
/// supplied a display name), holding only the redirect it just used and the
/// scopes the Owner actually granted.
///
/// The scopes go in collapsed, through the same [`widened_scopes`] the widening
/// path uses (against an empty registration), so a row created by a first
/// approval and a row widened into the same state are byte-identical — the
/// approval order can't leave two clients with differently-spelled but
/// equivalent ceilings.
fn new_registration(
    client_id: &str,
    redirect_uri: &Url,
    granted_scopes: &[String],
    now: DateTime<Utc>,
) -> Client {
    Client {
        client_id: client_id.to_owned(),
        name: client_id.to_owned(),
        kind: ClientKind::Public,
        redirect_uris: vec![RegisteredRedirectUri::Absolute(redirect_uri.clone())],
        allowed_scopes: widened_scopes(&[], granted_scopes),
        allowed_grant_types: AllowedGrantType::ALL.to_vec(),
        secret_hash: None,
        registered_at: now,
        disabled_at: None,
    }
}

/// Widen an existing registration by what the Owner just approved: append the
/// `redirect_uri` as an absolute entry when it resolved to none of the existing
/// ones, and widen `allowed_scopes` by the granted scopes. Everything else on
/// the row (its name, kind, secret, registration time) is left exactly as it
/// was.
///
/// The scope half is [`scopes_rust::widened_scopes`], not a string union: the
/// granted scopes are parsed, so an approval that grants
/// `patient/Patient.cruds` **replaces** a registered `patient/Patient.r`
/// instead of leaving the row carrying both, and granting again what the row
/// already covers leaves it untouched. `allowed_scopes` is only ever read
/// through [`scopes_rust::allowed_scope_covers`] (at `/authorize`, at
/// `/device_authorization`, and in
/// [`classify_registration`](crate::domain::client_registration::classify_registration)),
/// so a collapsed row admits exactly the requests the un-collapsed one did.
fn widen_registration(
    mut client: Client,
    redirect_uri: &Url,
    granted_scopes: &[String],
    adds_redirect: bool,
) -> Client {
    if adds_redirect {
        client
            .redirect_uris
            .push(RegisteredRedirectUri::Absolute(redirect_uri.clone()));
    }
    client.allowed_scopes = widened_scopes(&client.allowed_scopes, granted_scopes);
    client
}

#[cfg(test)]
mod tests {

    use super::*;
    use crate::domain::client_registration::uncovered_scopes;
    use crate::domain::test_fake::{client, delegated_scopes, FakeGatekeeperStore};

    fn redirect() -> Url {
        Url::parse("https://example.com/cb").expect("a valid redirect")
    }

    /// A first record inserts the grant; a second on the same `(client,
    /// redirect)` updates that same row, unioning the scopes and taking the
    /// latest patient — never a duplicate.
    #[test]
    fn record_code_grant_inserts_then_unions_scopes() {
        let store = FakeGatekeeperStore::default();
        let recorder = GrantRecorder::over(&store);
        recorder
            .record_code_grant(
                "client-a",
                &redirect(),
                &delegated_scopes(&["patient/Patient.r"]),
                Some("pat-1"),
                Utc::now(),
                None,
            )
            .unwrap();
        let first = store
            .grant_by_client_and_redirect("client-a", &redirect())
            .unwrap()
            .expect("grant inserted");
        assert_eq!(first.scopes, ["patient/Patient.r"]);

        recorder
            .record_code_grant(
                "client-a",
                &redirect(),
                &delegated_scopes(&["patient/Patient.r", "patient/Observation.r"]),
                Some("pat-2"),
                Utc::now(),
                None,
            )
            .unwrap();
        let merged = store
            .grant_by_client_and_redirect("client-a", &redirect())
            .unwrap()
            .expect("grant present");
        assert_eq!(
            merged.id, first.id,
            "the same grant is updated, not duplicated"
        );
        assert_eq!(
            merged.scopes,
            ["patient/Patient.r", "patient/Observation.r"]
        );
        assert_eq!(merged.patient.as_deref(), Some("pat-2"));
    }

    /// No registration to widen writes no client row at all, even when none exists — the
    /// first-party host is never registered by an approval.
    #[test]
    fn record_code_grant_without_widening_never_creates_a_client() {
        let store = FakeGatekeeperStore::default();
        GrantRecorder::over(&store)
            .record_code_grant(
                "host",
                &redirect(),
                &delegated_scopes(&["openid"]),
                None,
                Utc::now(),
                None,
            )
            .unwrap();
        assert_eq!(store.client_by_id("host").unwrap(), None);
    }

    /// Widening an unknown client's `New` verdict creates the trust-on-first-use row
    /// holding exactly the delegated scopes and the approved redirect.
    #[test]
    fn record_code_grant_widen_registers_a_new_client_with_the_delegated_scopes() {
        let store = FakeGatekeeperStore::default();
        GrantRecorder::over(&store)
            .record_code_grant(
                "newcomer",
                &redirect(),
                &delegated_scopes(&["patient/Patient.r", "openid"]),
                None,
                Utc::now(),
                Some(&ClientRegistration::New),
            )
            .unwrap();
        let row = store
            .client_by_id("newcomer")
            .unwrap()
            .expect("registered on first use");
        assert_eq!(row.allowed_scopes, ["patient/Patient.r", "openid"]);
        assert_eq!(
            row.redirect_uris,
            [RegisteredRedirectUri::Absolute(redirect())]
        );
        assert_eq!(row.kind, ClientKind::Public);
    }

    /// Widening a known client by a verdict whose redirect is already
    /// allowlisted widens the scopes but leaves the allowlist alone; one whose
    /// redirect is new appends it.
    #[test]
    fn record_code_grant_widening_appends_only_a_new_redirect() {
        let elsewhere = Url::parse("https://other.example/cb").unwrap();
        for (redirect_uri_is_new, expected_redirects) in [
            (false, vec![RegisteredRedirectUri::Absolute(redirect())]),
            (
                true,
                vec![
                    RegisteredRedirectUri::Absolute(redirect()),
                    RegisteredRedirectUri::Absolute(elsewhere.clone()),
                ],
            ),
        ] {
            let store = FakeGatekeeperStore::default();
            store.upsert_client(&client("app", &["openid"])).unwrap();
            let verdict = ClientRegistration::Changed {
                redirect_uri_is_new,
                unregistered_requested_scopes: vec!["patient/Patient.r".to_owned()],
            };
            GrantRecorder::over(&store)
                .record_code_grant(
                    "app",
                    &elsewhere,
                    &delegated_scopes(&["patient/Patient.r"]),
                    None,
                    Utc::now(),
                    Some(&verdict),
                )
                .unwrap();
            let row = store.client_by_id("app").unwrap().expect("present");
            assert_eq!(row.redirect_uris, expected_redirects);
            assert_eq!(row.allowed_scopes, ["openid", "patient/Patient.r"]);
        }
    }

    /// The device grant follows the same insert-then-union shape, keyed on the
    /// device name.
    #[test]
    fn record_device_grant_inserts_then_unions_scopes() {
        let store = FakeGatekeeperStore::default();
        let recorder = GrantRecorder::over(&store);
        recorder
            .record_device_grant(
                "client-a",
                "Kitchen iPad",
                &delegated_scopes(&["patient/Patient.r"]),
                None,
                Utc::now(),
            )
            .unwrap();
        recorder
            .record_device_grant(
                "client-a",
                "Kitchen iPad",
                &delegated_scopes(&["patient/Observation.r"]),
                None,
                Utc::now(),
            )
            .unwrap();
        let grant = store
            .device_grant_by_client_and_device_name("client-a", "Kitchen iPad")
            .unwrap()
            .expect("present");
        assert_eq!(grant.scopes, ["patient/Patient.r", "patient/Observation.r"]);
    }

    /// Widen the fixture client (registered with `registered`) by `granted`,
    /// leaving its redirect allowlist alone.
    fn widened(registered: &[&str], granted: &[&str]) -> Vec<String> {
        let granted: Vec<String> = granted.iter().map(|s| (*s).to_owned()).collect();
        widen_registration(client("app", registered), &redirect(), &granted, false).allowed_scopes
    }

    /// The registration records the *broader* grant rather than accumulating
    /// both spellings of the same resource.
    #[test]
    fn a_broader_grant_replaces_the_narrower_registered_scope() {
        assert_eq!(
            widened(&["patient/Patient.r", "openid"], &["patient/Patient.cruds"]),
            ["patient/Patient.cruds", "openid"]
        );
    }

    /// Two disjoint interactions on one resource are recorded as the single
    /// scope granting both, not as two rows.
    #[test]
    fn disjoint_interactions_on_one_resource_become_one_scope() {
        assert_eq!(
            widened(&["patient/Patient.r"], &["patient/Patient.s"]),
            ["patient/Patient.rs"]
        );
    }

    /// Re-approving what the row already covers leaves it byte-identical — the
    /// common case, where an app the Owner has approved before asks again.
    #[test]
    fn re_granting_a_covered_scope_leaves_the_row_untouched() {
        let registered = ["patient/*.cruds", "openid"];
        assert_eq!(
            widened(&registered, &["patient/Observation.r", "openid"]),
            registered
        );
    }

    /// A v1 word registration is never folded into a letter bag — that would
    /// hand the client letter-grammar access it was never registered for. The
    /// two spellings sit side by side until one genuinely covers the other.
    #[test]
    fn a_v1_word_registration_is_not_merged_into_letter_access() {
        assert_eq!(
            widened(&["patient/Patient.read"], &["patient/Patient.c"]),
            ["patient/Patient.read", "patient/Patient.c"]
        );
        assert_eq!(
            widened(&["patient/Patient.read"], &["patient/Patient.cruds"]),
            ["patient/Patient.cruds"]
        );
    }

    /// The property the trust-on-first-use path depends on: after widening, the
    /// same request classifies as fully covered — collapsing the row must never
    /// cost it coverage of what was just granted.
    #[test]
    fn everything_granted_is_covered_by_the_widened_row() {
        let granted = [
            "patient/Patient.r",
            "patient/Patient.s",
            "patient/Observation.read",
            "openid",
            "a_stray_unknown",
        ];
        let owned: Vec<String> = granted.iter().map(|s| (*s).to_owned()).collect();
        let widened = widened(&["patient/Condition.r"], &granted);
        assert!(uncovered_scopes(&widened, &owned).is_empty());
        // ...and the pre-existing registration survives it.
        assert!(uncovered_scopes(&widened, &["patient/Condition.r".to_owned()]).is_empty());
    }

    /// A row created by a first approval and a row widened into the same state
    /// agree exactly — `new_registration` and `widen_registration` share one
    /// collapse.
    #[test]
    fn a_new_registration_matches_a_row_widened_into_the_same_state() {
        let granted: Vec<String> = ["patient/Patient.r", "patient/Patient.s", "openid"]
            .iter()
            .map(|s| (*s).to_owned())
            .collect();
        let fresh = new_registration("app", &redirect(), &granted, Utc::now());
        assert_eq!(fresh.allowed_scopes, ["patient/Patient.rs", "openid"]);
        assert_eq!(
            fresh.allowed_scopes,
            widened(&[], &["patient/Patient.r", "patient/Patient.s", "openid"])
        );
    }

    /// Widening the scopes never touches the redirect allowlist, and a new
    /// redirect is appended without disturbing the registered ones.
    #[test]
    fn the_redirect_allowlist_moves_only_when_the_redirect_is_new() {
        let registered = client("app", &["openid"]);
        let elsewhere = Url::parse("https://other.example/cb").unwrap();
        let granted = vec!["openid".to_owned()];

        let unchanged = widen_registration(registered.clone(), &elsewhere, &granted, false);
        assert_eq!(unchanged.redirect_uris, registered.redirect_uris);

        let appended = widen_registration(registered.clone(), &elsewhere, &granted, true);
        assert_eq!(
            appended.redirect_uris,
            [
                registered.redirect_uris[0].clone(),
                RegisteredRedirectUri::Absolute(elsewhere),
            ]
        );
    }
}
