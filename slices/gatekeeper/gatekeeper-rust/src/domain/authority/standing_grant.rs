//! [`StandingGrantCoverage`] — the proof behind the `/oauth/authorize` fast
//! path: a standing authorization-code grant the Owner established earlier
//! already covers **every** scope this request asks for, so a code may be
//! issued with no human in the loop (RFC 6749 §4.1 permits skipping consent
//! on a prior decision). It is only ever built by [`GrantCoverage::resolve`],
//! which is the whole rule: it yields [`GrantCoverage::Full`] only for a request
//! inside the client's registration, however well an old grant covers one
//! outside it — the Owner has not yet seen *this* app/redirect/scope
//! combination.

use url::Url;

use crate::domain::client_registration::ClientRegistration;
use crate::domain::gatekeeper_error::GatekeeperError;
use crate::domain::GatekeeperStore;

/// How far a standing grant covers a request. Only [`Full`](Self::Full) is a
/// proof; the other two carry what the consent prompt pre-ticks.
pub(crate) enum GrantCoverage {
    /// No standing grant for this `(client, redirect_uri)`, or the request is
    /// outside the registration.
    Uncovered,
    /// A grant covers some of the requested scopes — the prompt pre-ticks them,
    /// the Owner decides the rest.
    Partial { pre_approved_scopes: Vec<String> },
    /// Every requested scope is covered: the fast path.
    Full(StandingGrantCoverage),
}

impl GrantCoverage {
    /// Look up the standing grant for `(requested_client_id,
    /// requested_redirect_uri)` and compute
    /// which of `requested_scopes` it covers. A request whose `registration`
    /// verdict is not [`Registered`](ClientRegistration::Registered) never
    /// resolves past [`GrantCoverage::Uncovered`], whatever the grant says.
    ///
    /// "Covers" is [`scopes_rust::allowed_scope_covers`], not string equality: a
    /// standing grant is a set of permissions, so `patient/*.cruds` answers for
    /// a later `patient/Observation.r`, and a grant the approval collapsed
    /// (`.r` + `.s` recorded as `.rs`) still answers for either half.
    ///
    /// # Errors
    ///
    /// [`GatekeeperError::Infrastructure`] on a store failure.
    pub(crate) fn resolve(
        store: &impl GatekeeperStore,
        registration_verdict: &ClientRegistration,
        requested_client_id: &str,
        requested_redirect_uri: &Url,
        requested_scopes: &[String],
    ) -> Result<GrantCoverage, GatekeeperError> {
        if !registration_verdict.is_registered() {
            return Ok(GrantCoverage::Uncovered);
        }
        let Some(grant) =
            store.grant_by_client_and_redirect(requested_client_id, requested_redirect_uri)?
        else {
            return Ok(GrantCoverage::Uncovered);
        };
        let pre_approved_scopes: Vec<String> = requested_scopes
            .iter()
            .filter(|requested| {
                grant
                    .scopes
                    .iter()
                    .any(|granted| scopes_rust::allowed_scope_covers(granted, requested))
            })
            .cloned()
            .collect();
        // `pre_approved_scopes` is `requested_scopes` filtered, so equal lengths
        // means nothing was filtered out.
        if pre_approved_scopes.len() == requested_scopes.len() {
            Ok(GrantCoverage::Full(StandingGrantCoverage {
                covered_scopes: pre_approved_scopes,
                patient: grant.patient,
            }))
        } else {
            Ok(GrantCoverage::Partial {
                pre_approved_scopes,
            })
        }
    }

    /// The requested scopes the standing grant already covers, for the parked
    /// request's `pre_approved_scopes`.
    pub(crate) fn pre_approved_scopes(&self) -> &[String] {
        match self {
            GrantCoverage::Uncovered => &[],
            GrantCoverage::Partial {
                pre_approved_scopes,
            } => pre_approved_scopes,
            GrantCoverage::Full(full) => &full.covered_scopes,
        }
    }
}

/// Proof that a standing grant covers every scope of a registered request.
/// Carries those scopes (the requested set, verbatim) and the grant's patient
/// context; the fields are private and only [`GrantCoverage::resolve`] builds
/// one.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct StandingGrantCoverage {
    covered_scopes: Vec<String>,
    patient: Option<String>,
}

impl StandingGrantCoverage {
    /// The covered scopes — the request's, verbatim.
    pub(crate) fn covered_scopes(&self) -> &[String] {
        &self.covered_scopes
    }

    /// The grant's SMART-on-FHIR patient context, if any.
    pub(crate) fn patient(&self) -> Option<&str> {
        self.patient.as_deref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::grant::AuthorizationCodeGrant;
    use crate::domain::test_fake::{code_grant, owned_scopes, FakeGatekeeperStore};

    fn redirect() -> Url {
        Url::parse("https://example.com/cb").unwrap()
    }

    fn store_with_grant(scopes: &[&str], patient: Option<&str>) -> FakeGatekeeperStore {
        let store = FakeGatekeeperStore::default();
        store
            .create_authorization_code_grant(&AuthorizationCodeGrant {
                scopes: owned_scopes(scopes),
                patient: patient.map(str::to_owned),
                ..code_grant("g1", "client")
            })
            .unwrap();
        store
    }

    /// A registered request every scope of which the grant covers resolves to
    /// the fast-path proof, carrying the requested scopes and the grant's
    /// patient. Coverage is by permission, not spelling.
    #[test]
    fn full_coverage_is_a_proof_carrying_the_requested_scopes() {
        let store = store_with_grant(&["patient/*.cruds", "openid"], Some("pat-1"));
        let coverage = GrantCoverage::resolve(
            &store,
            &ClientRegistration::Registered,
            "client",
            &redirect(),
            &owned_scopes(&["patient/Observation.r", "openid"]),
        )
        .unwrap();
        let GrantCoverage::Full(proof) = coverage else {
            panic!("expected full coverage");
        };
        assert_eq!(proof.covered_scopes(), ["patient/Observation.r", "openid"]);
        assert_eq!(proof.patient(), Some("pat-1"));
    }

    /// A grant covering only some scopes pre-ticks those and is not a proof.
    #[test]
    fn partial_coverage_pre_ticks_without_proving() {
        let store = store_with_grant(&["openid"], None);
        let coverage = GrantCoverage::resolve(
            &store,
            &ClientRegistration::Registered,
            "client",
            &redirect(),
            &owned_scopes(&["patient/Observation.r", "openid"]),
        )
        .unwrap();
        assert!(matches!(coverage, GrantCoverage::Partial { .. }));
        assert_eq!(coverage.pre_approved_scopes(), ["openid"]);
    }

    /// The escalation the proof rules out: a request outside the registration
    /// never fast-paths, however well the old grant covers it, and a pair with
    /// no grant has nothing to cover.
    #[test]
    fn unregistered_requests_and_missing_grants_never_prove() {
        let store = store_with_grant(&["patient/*.cruds", "openid"], None);
        let requested = owned_scopes(&["openid"]);
        let outside = GrantCoverage::resolve(
            &store,
            &ClientRegistration::New,
            "client",
            &redirect(),
            &requested,
        )
        .unwrap();
        assert!(matches!(outside, GrantCoverage::Uncovered));
        assert!(outside.pre_approved_scopes().is_empty());

        let no_grant = GrantCoverage::resolve(
            &store,
            &ClientRegistration::Registered,
            "stranger",
            &redirect(),
            &requested,
        )
        .unwrap();
        assert!(matches!(no_grant, GrantCoverage::Uncovered));
    }
}
