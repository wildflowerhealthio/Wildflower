use super::*;
use proptest::prelude::*;

/// `rs` permission, built through the parser so these tests don't reach
/// into `Permission`'s private representation.
fn rs() -> Permission {
    Permission::parse_segment("rs").unwrap()
}

#[test]
fn typed_builders_render_to_the_expected_strings() {
    assert_eq!(
        Scope::wildflower(WildflowerResource::Grant, Permission::READ).to_string(),
        "wildflower/Grant.r",
    );
    assert_eq!(
        Scope::wildflower_all(Permission::DELETE).to_string(),
        "wildflower/*.d",
    );
    assert_eq!(
        Scope::fhir_system_all(Permission::READ_SEARCH).to_string(),
        "system/*.rs",
    );
    assert_eq!(
        Scope::fhir_system_all(Permission::DELETE).to_string(),
        "system/*.d",
    );
}

#[test]
fn typed_builders_agree_with_string_parsing() {
    // A builder is a typo-proof spelling of the same scope the parser yields.
    assert_eq!(
        Scope::fhir_system_all(Permission::READ_SEARCH),
        Scope::from("system/*.rs"),
    );
    assert_eq!(
        Scope::fhir_system_all(Permission::DELETE),
        Scope::from("system/*.d"),
    );
    assert_eq!(
        Scope::wildflower_all(Permission::READ),
        Scope::from("wildflower/*.r"),
    );
    assert_eq!(
        Scope::wildflower(WildflowerResource::Grant, Permission::DELETE),
        Scope::from("wildflower/Grant.d"),
    );
}

#[test]
fn parse_prefers_known_over_resource() {
    assert_eq!(Scope::from("openid"), Scope::Known(KnownScope::Openid));
    assert_eq!(
        Scope::from("launch/patient"),
        Scope::Known(KnownScope::LaunchPatient)
    );
}

#[test]
fn parse_fhir_resource_richest() {
    assert_eq!(
        Scope::from("patient/Observation.read"),
        Scope::FhirResource(FhirResourceScope {
            context: ContextLevel::Patient,
            resource: ResourceType::Known("Observation".to_string()),
            permission: Permission::parse_segment("read").unwrap(),
        })
    );
    assert_eq!(
        Scope::from("system/*.cruds"),
        Scope::FhirResource(FhirResourceScope {
            context: ContextLevel::System,
            resource: ResourceType::Wildcard,
            permission: Permission::ALL,
        })
    );
}

#[test]
fn wildflower_scopes_are_their_own_kind() {
    // `wildflower/Grant.cruds` is a Wildflower scope...
    assert_eq!(
        Scope::from("wildflower/Grant.cruds"),
        Scope::WildflowerResource(WildflowerResourceScope {
            resource: WildflowerResourceType::Known(WildflowerResource::Grant),
            permission: Permission::ALL,
        })
    );
    // ...whereas `system/Grant.cruds` is just a FHIR scope named "Grant" —
    // the Wildflower resource set is reachable *only* under `wildflower/`.
    assert_eq!(
        Scope::from("system/Grant.cruds"),
        Scope::FhirResource(FhirResourceScope {
            context: ContextLevel::System,
            resource: ResourceType::Known("Grant".to_string()),
            permission: Permission::ALL,
        })
    );
}

#[test]
fn parse_falls_back_to_unknown() {
    // Retired admin scope, an unknown wildflower resource, a stray-letter
    // perm bag, and v1-worded wildflower scopes (the word grammar is
    // FHIR-only) all preserve verbatim rather than misparse.
    for s in [
        "wildflower/admin",
        "wildflower/Nope.cruds",
        "patient/Observation.rx",
        "wildflower/Grant.*",
        "wildflower/*.write",
    ] {
        assert_eq!(Scope::from(s), Scope::Unknown(UnknownScope::new(s)));
    }
}

#[test]
fn display_round_trips_v1_words_and_canonicalizes_letter_order() {
    // SMART v1 word forms round-trip verbatim (back-compat: a v1 grant is
    // returned as v1, not collapsed to its letter equivalent).
    assert_eq!(
        Scope::from("patient/Observation.read").to_string(),
        "patient/Observation.read"
    );
    assert_eq!(Scope::from("user/*.write").to_string(), "user/*.write");
    assert_eq!(Scope::from("system/*.*").to_string(), "system/*.*");
    // v2 letter bags normalize to canonical c,r,u,d,s order.
    assert_eq!(
        Scope::from("patient/Observation.sr").to_string(),
        "patient/Observation.rs"
    );
    assert_eq!(Scope::from("system/*.cruds").to_string(), "system/*.cruds");
    // Non-resource scopes round-trip unchanged.
    assert_eq!(Scope::from("openid").to_string(), "openid");
}

#[test]
fn parse_strips_search_param_suffix() {
    let scope = Scope::from("patient/Observation.rs?category=http://x|y");
    assert_eq!(
        scope,
        Scope::FhirResource(FhirResourceScope {
            context: ContextLevel::Patient,
            resource: ResourceType::Known("Observation".to_string()),
            permission: rs(),
        })
    );
    assert_eq!(scope.to_string(), "patient/Observation.rs");
}

#[test]
fn covers_fhir_rules() {
    let covers = |a: &str, b: &str| Scope::from(a).covers(&Scope::from(b));
    assert!(covers("system/*.cruds", "system/Patient.r")); // wildcard + perm subset
    assert!(covers("patient/*.*", "patient/Observation.read")); // v1 word subset
    assert!(!covers(
        "patient/Observation.read",
        "patient/Observation.rs"
    )); // word grant ⊉ letter request
    assert!(covers(
        "patient/Observation.cruds",
        "patient/Observation.read"
    )); // ...but letter grant ⊇ equivalent word request
    assert!(covers("system/*.cruds", "user/Patient.r")); // context: system covers all
    assert!(!covers("user/*.cruds", "patient/Observation.r")); // context: user ⊉ patient
    assert!(!covers("patient/*.cruds", "user/Patient.r")); // context: patient ⊉ user
    assert!(!covers("system/Patient.r", "system/Patient.cruds")); // perm not covered
    assert!(!covers("system/Patient.cruds", "system/*.cruds")); // specific !covers wildcard
}

#[test]
fn covers_wildflower_rules() {
    let covers = |a: &str, b: &str| Scope::from(a).covers(&Scope::from(b));
    assert!(covers("wildflower/Grant.cruds", "wildflower/Grant.r")); // perm subset
    assert!(covers("wildflower/*.cruds", "wildflower/Grant.r")); // wildcard covers any
    assert!(!covers("wildflower/Grant.cruds", "wildflower/Client.r")); // explicit resource
    assert!(!covers("wildflower/Grant.cruds", "wildflower/*.r")); // specific !covers wildcard
                                                                  // FHIR full access does NOT reach Wildflower resources, and vice versa.
    assert!(!covers("system/*.cruds", "wildflower/Grant.cruds"));
    assert!(!covers("wildflower/Grant.cruds", "system/Grant.cruds"));
    // Word-form wildflower strings parse as Unknown: exact-match only.
    assert!(!covers("wildflower/Grant.cruds", "wildflower/Grant.read"));
    assert!(covers("wildflower/Grant.read", "wildflower/Grant.read"));
}

#[test]
fn covers_known_and_unknown_match_exactly() {
    assert!(Scope::from("offline_access").covers(&Scope::from("offline_access")));
    assert!(!Scope::from("offline_access").covers(&Scope::from("openid")));
    assert!(Scope::from("wildflower/admin").covers(&Scope::from("wildflower/admin")));
    assert!(!Scope::from("system/*.cruds").covers(&Scope::from("offline_access")));
}

#[test]
fn from_and_fromstr_agree() {
    assert_eq!(Scope::from("openid"), "openid".parse::<Scope>().unwrap());
    assert_eq!(
        Scope::from("wildflower/Grant.cruds"),
        "wildflower/Grant.cruds".parse::<Scope>().unwrap()
    );
}

#[test]
fn wildflower_scopes_round_trip_byte_compatibly() {
    for s in [
        "wildflower/*.cruds",
        "wildflower/Grant.cruds",
        "wildflower/AuthorizationRequest.rs",
        "wildflower/Client.cud",
    ] {
        assert_eq!(Scope::from(s).to_string(), s);
        assert_eq!(
            serde_json::to_string(&Scope::from(s)).unwrap(),
            serde_json::to_string(s).unwrap()
        );
    }
}

/// Canonical interaction letters for a raw bit set, independent of
/// `Permission`'s private representation.
fn canonical_letters(bits: u8) -> String {
    [(1u8, 'c'), (2, 'r'), (4, 'u'), (8, 'd'), (16, 's')]
        .into_iter()
        .filter(|(b, _)| bits & b != 0)
        .map(|(_, c)| c)
        .collect()
}

proptest! {
    /// A canonical FHIR scope string serializes byte-identically whether it's
    /// a `String` or a parsed `Scope` — the property a future
    /// `JsonColumn<Vec<Scope>>` relies on to avoid a migration.
    #[test]
    fn serde_is_byte_compatible_for_canonical_scopes(
        ctx in prop::sample::select(vec!["patient", "user", "system"]),
        rtype in prop::sample::select(vec!["*", "Patient", "Observation"]),
        bits in 1u8..=31u8,
    ) {
        let canonical = format!("{ctx}/{rtype}.{}", canonical_letters(bits));
        let via_scope = serde_json::to_string(&Scope::from(canonical.as_str())).unwrap();
        let via_string = serde_json::to_string(&canonical).unwrap();
        prop_assert_eq!(via_scope, via_string);
    }

    /// [`Grant::collapse`] is an access-preserving rewrite: it may only shorten
    /// the list, it reaches exactly the same single-interaction atoms as before,
    /// it still admits every scope it started with, and running it twice changes
    /// nothing. These are the properties `widened_scopes` leans on to be safe on
    /// an authorization ceiling.
    #[test]
    fn collapse_preserves_access_shrinks_and_is_idempotent(
        raw in prop::collection::vec(
            (
                prop::sample::select(vec!["patient", "user", "system"]),
                prop::sample::select(vec!["*", "Patient", "Observation"]),
                // Both grammars, so the letter/word partition is exercised.
                prop::sample::select(vec![
                    "c", "r", "u", "d", "s", "rs", "cud", "cruds", "read", "write", "*",
                ]),
            ),
            0..8,
        ),
    ) {
        let before = Grant::parse(
            raw.iter().map(|(ctx, rtype, perms)| format!("{ctx}/{rtype}.{perms}")),
        );
        let mut after = before.clone();
        after.collapse();

        // Never longer than what it started with.
        prop_assert!(after.scopes.len() <= before.scopes.len());

        // Every input scope is still admitted — nothing was consented away.
        for scope in &before.scopes {
            prop_assert!(after.covers(scope), "collapse dropped {}", scope);
        }

        // Identical access, atom by atom: one interaction on one concrete
        // resource is the finest thing a grant can confer.
        for ctx in ["patient", "user", "system"] {
            for rtype in ["Patient", "Observation", "Condition"] {
                for atom in ["c", "r", "u", "d", "s"] {
                    let probe = Scope::from(format!("{ctx}/{rtype}.{atom}").as_str());
                    prop_assert_eq!(
                        after.covers(&probe),
                        before.covers(&probe),
                        "collapse changed access to {}",
                        probe
                    );
                }
            }
        }

        // A second pass is a no-op.
        let mut twice = after.clone();
        twice.collapse();
        prop_assert_eq!(twice.render(), after.render());
    }
}
