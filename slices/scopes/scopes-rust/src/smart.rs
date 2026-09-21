//! String-facing entry points to the scope grammar, implemented on top of the
//! structured [`Scope`] model. These keep the
//! `&str`/`Vec<String>` signatures gatekeeper's consent handlers call, parsing
//! to `Scope` internally so coverage and rendering share one implementation.

use std::collections::HashSet;

use crate::scope::{Grant, Scope};

/// The scopes an Owner approval can actually grant: those that are both still
/// requested by the pending request and covered by the client's *current*
/// `allowed_scopes`. The Owner can only narrow, never widen, and the `allowed`
/// clamp stops a stale request from granting a scope the client's policy no
/// longer permits.
///
/// Both sides match by **coverage**, not exact equality (each parsed to a [`Scope`]
/// and compared with [`Scope::covers`]). Coverage on the requested side is what
/// lets an Owner narrow: an approved `patient/Observation.s` is still ⊆ a requested
/// `patient/Observation.rs`, so it's granted where exact equality would drop it.
/// Coverage is wildcard/context-aware and bridges grammars one way — a v2 letter
/// scope covers the equivalent v1 word, but not the reverse (known/unknown match
/// exactly — see [`Scope::covers`]).
///
/// Every kept scope is rendered back to its own approved wire spelling (v1↔v2
/// back-compat — see [`Permission`](crate::Permission)), de-duplicated by rendered
/// form (first-seen order). An empty grant stays empty (approve handlers treat
/// "nothing granted" as a deny).
pub fn grantable_scopes(
    approved: Vec<String>,
    requested: &HashSet<&str>,
    allowed: &HashSet<&str>,
) -> Vec<String> {
    let requested: Vec<Scope> = requested.iter().map(|&s| Scope::from(s)).collect();
    let allowed: Vec<Scope> = allowed.iter().map(|&s| Scope::from(s)).collect();

    let mut seen: HashSet<String> = HashSet::new();
    let mut granted: Vec<String> = Vec::new();
    for approved_scope in approved.into_iter().map(|s| Scope::from(s.as_str())) {
        let is_requested = requested.iter().any(|r| r.covers(&approved_scope));
        let is_allowed = allowed.iter().any(|a| a.covers(&approved_scope));
        if is_requested && is_allowed {
            let rendered = approved_scope.to_string();
            if seen.insert(rendered.clone()) {
                granted.push(rendered);
            }
        }
    }
    granted
}

/// Widen the stored scope list `standing` by `additional`, returning the
/// collapsed union as wire strings — the string-facing form of
/// [`Grant::widen`](crate::Grant::widen), for callers holding `Vec<String>`
/// columns (a client's `allowed_scopes`, a standing grant's `scopes`).
///
/// The result grants exactly what the two lists granted between them, stated as
/// shortly as the grammar allows: `["patient/Patient.r"]` widened by
/// `["patient/Patient.cruds"]` is `["patient/Patient.cruds"]`, not both. Parsing
/// is total, so an unrecognized string survives as an `Unknown` scope that only
/// ever collapses against an identical twin.
pub fn widened_scopes(standing: &[String], additional: &[String]) -> Vec<String> {
    let mut grant = Grant::parse(standing);
    grant.widen(&Grant::parse(additional));
    grant.render()
}

/// Does the client-allowed scope `allowed` cover the approved scope `requested`?
/// Both sides are parsed to a [`Scope`] and compared with [`Scope::covers`]:
/// resource scopes match by context + resource-type (wildcard-aware) + a
/// permission-bit superset — a v2 letter-form `allowed` covers an equivalent v1
/// word request, but a v1 word-form `allowed` never covers a letter request;
/// known and unknown scopes match exactly.
pub fn allowed_scope_covers(allowed: &str, requested: &str) -> bool {
    Scope::from(allowed).covers(&Scope::from(requested))
}

/// Append each scope's equivalent alternate spelling, where it has one (see
/// [`Scope::as_alternate_canonical_form`]) — today, a resource scope in SMART v1
/// word form gaining its canonical v2 letter form.
///
/// Some consumers parse only one spelling — notably helios-auth's
/// `SmartPermissions`, which HFS uses to authorize FHIR requests and which reads
/// **only** the SMART v2 letter grammar, silently dropping a `.read`/`.write`/`.*`
/// segment. Emitting both spellings into a token's `scope` claim means such a
/// consumer still honors the grant, while consumers that read the original
/// spelling keep working (the originals are preserved verbatim). Only the extra
/// alternates are added — de-duplicated against the input, order-preserving, and
/// idempotent.
pub fn with_alternate_canonical_forms(scopes: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(scopes.len());
    for s in scopes {
        out.push(s.clone());
        if let Some(alternate) = Scope::from(s.as_str()).as_alternate_canonical_form() {
            let alternate = alternate.to_string();
            // Skip an alternate the caller already granted (idempotency) or that
            // an earlier original in this pass already produced.
            let already_granted = scopes.iter().any(|x| x == &alternate);
            if !already_granted && !out.contains(&alternate) {
                out.push(alternate);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s<'a>(v: &[&'a str]) -> HashSet<&'a str> {
        v.iter().copied().collect()
    }

    #[test]
    fn exact_match_grants() {
        assert!(allowed_scope_covers("offline_access", "offline_access"));
        assert!(allowed_scope_covers("an_unknown_scope", "an_unknown_scope"));
    }

    #[test]
    fn type_wildcard_covers_specific_type() {
        assert!(allowed_scope_covers("system/*.cruds", "system/Patient.r"));
        assert!(allowed_scope_covers(
            "system/*.cruds",
            "system/Observation.cruds"
        ));
    }

    #[test]
    fn narrower_perms_covered_by_broader_perms() {
        assert!(allowed_scope_covers(
            "system/Patient.cruds",
            "system/Patient.rs"
        ));
        assert!(allowed_scope_covers(
            "user/Observation.rs",
            "user/Observation.r"
        ));
    }

    #[test]
    fn context_hierarchy_only_system_covers_downward() {
        // `system` covers every context...
        assert!(allowed_scope_covers("system/*.cruds", "user/Patient.r"));
        assert!(allowed_scope_covers("system/*.cruds", "patient/Patient.r"));
        // ...but `user` and `patient` cover only themselves: a patient-launch
        // scope is bound to the launch patient, not the user's own access.
        assert!(!allowed_scope_covers("user/*.cruds", "patient/Patient.r"));
        assert!(!allowed_scope_covers("patient/*.cruds", "user/Patient.r"));
        assert!(!allowed_scope_covers("user/*.cruds", "system/Patient.r"));
    }

    #[test]
    fn missing_perm_bit_rejects() {
        assert!(!allowed_scope_covers(
            "system/Patient.r",
            "system/Patient.cruds"
        ));
        assert!(!allowed_scope_covers(
            "system/Patient.rs",
            "system/Patient.u"
        ));
    }

    #[test]
    fn non_smart_scopes_only_match_exactly() {
        // No `/` + `.` resource shape, so these parse to `Known`/`Unknown` and
        // never cross-cover a resource scope.
        assert!(!allowed_scope_covers("system/*.cruds", "offline_access"));
        assert!(!allowed_scope_covers("offline_access", "system/Patient.r"));
    }

    #[test]
    fn v1_word_perms_cover_only_within_the_word_grammar() {
        // `*` is the word-grammar superset of both words...
        assert!(allowed_scope_covers(
            "patient/*.*",
            "patient/Observation.read"
        ));
        assert!(allowed_scope_covers(
            "patient/*.*",
            "patient/Observation.write"
        ));
        assert!(allowed_scope_covers(
            "patient/Observation.read",
            "patient/Observation.read"
        ));
        // ...but the words are disjoint, and neither reaches up to `*`.
        assert!(!allowed_scope_covers(
            "patient/Observation.read",
            "patient/Observation.write"
        ));
        assert!(!allowed_scope_covers(
            "patient/Observation.read",
            "patient/Observation.*"
        ));
    }

    #[test]
    fn v1_and_v2_perms_cross_cover_letter_over_word_only() {
        // A v2 letter grant covers the equivalent v1 word request (same interaction
        // bits) — the live case, since tokens are minted in the letter grammar.
        assert!(allowed_scope_covers(
            "patient/Patient.cruds",
            "patient/Patient.read"
        ));
        // But a v1 word grant never covers a v2 letter request — a word-registered
        // client can't reach into letter-grammar access.
        assert!(!allowed_scope_covers(
            "patient/Patient.read",
            "patient/Patient.rs"
        ));
        assert!(!allowed_scope_covers(
            "patient/Patient.*",
            "patient/Patient.cruds"
        ));
        assert!(!allowed_scope_covers(
            "patient/*.*",
            "patient/Observation.d"
        ));
    }

    #[test]
    fn invalid_perm_segments_reject() {
        // A stray non-interaction letter makes the segment unparseable, so the
        // scope is `Unknown` and only matches the identical string.
        assert!(!allowed_scope_covers(
            "patient/Observation.rx",
            "patient/Observation.r"
        ));
        assert!(!allowed_scope_covers(
            "patient/Observation.r",
            "patient/Observation.rx"
        ));
    }

    #[test]
    fn grantable_filters_by_requested_and_allowed_coverage() {
        let approved = vec![
            "system/Patient.r".to_string(),
            "offline_access".to_string(),
            "user/Observation.r".to_string(), // not requested
        ];
        let requested = s(&["system/Patient.r", "offline_access"]);
        let allowed = s(&["system/*.cruds", "offline_access"]);
        let granted = grantable_scopes(approved, &requested, &allowed);
        assert_eq!(granted, vec!["system/Patient.r", "offline_access"]);
    }

    #[test]
    fn grantable_drops_uncovered_approvals() {
        let approved = vec!["system/Patient.cruds".to_string()];
        let requested = s(&["system/Patient.cruds"]);
        // Allowed grants only `system/*.r` — `cruds` is broader than `r`.
        let allowed = s(&["system/*.r"]);
        let granted = grantable_scopes(approved, &requested, &allowed);
        assert!(granted.is_empty());
    }

    #[test]
    fn grantable_preserves_v1_word_scopes() {
        // The growth-chart case: a v1 `.read` scope is granted and returned
        // verbatim (SMART back-compat — a v1 grant is returned as v1).
        let approved = vec!["patient/Observation.read".to_string()];
        let requested = s(&["patient/Observation.read"]);
        let allowed = s(&["patient/Observation.read"]);
        let granted = grantable_scopes(approved, &requested, &allowed);
        assert_eq!(granted, vec!["patient/Observation.read"]);
    }

    #[test]
    fn grantable_preserves_write_and_wildcard_words() {
        let approved = vec![
            "patient/Observation.write".to_string(),
            "patient/Patient.*".to_string(),
        ];
        let requested = s(&["patient/Observation.write", "patient/Patient.*"]);
        let allowed = s(&["patient/*.*"]);
        let granted = grantable_scopes(approved, &requested, &allowed);
        assert_eq!(
            granted,
            vec!["patient/Observation.write", "patient/Patient.*"]
        );
    }

    #[test]
    fn grantable_keeps_distinct_word_and_letter_forms() {
        // Owner approved both the word and the letter form — they're distinct
        // scopes (each round-trips to its own spelling), so both are emitted.
        let approved = vec![
            "patient/Observation.read".to_string(),
            "patient/Observation.rs".to_string(),
        ];
        let requested = s(&["patient/Observation.read", "patient/Observation.rs"]);
        // Each approval round-trips to its own wire form, so both spellings are
        // emitted (deduplicated by rendered form); `patient/*.cruds` covers both.
        let allowed = s(&["patient/*.cruds", "patient/*.*"]);
        let granted = grantable_scopes(approved, &requested, &allowed);
        assert_eq!(
            granted,
            vec!["patient/Observation.read", "patient/Observation.rs"]
        );
    }

    #[test]
    fn grantable_grants_owner_narrowed_v2_letters() {
        // The client requested `.rs`; the Owner approved the tighter `.s`.
        // `.s` ⊆ `.rs`, so coverage on the requested side keeps it — an
        // exact-equality check would have dropped this narrowed approval.
        let approved = vec!["patient/Observation.s".to_string()];
        let requested = s(&["patient/Observation.rs"]);
        let allowed = s(&["patient/*.cruds"]);
        let granted = grantable_scopes(approved, &requested, &allowed);
        assert_eq!(granted, vec!["patient/Observation.s"]);
    }

    #[test]
    fn grantable_grants_wildcard_requested_narrowed_to_concrete_type() {
        // A wildcard request covers a concrete-type approval: `patient/*.r`
        // covers `patient/Observation.r`, so the concrete grant is within the
        // requested envelope and is kept.
        let approved = vec!["patient/Observation.r".to_string()];
        let requested = s(&["patient/*.r"]);
        let allowed = s(&["patient/*.cruds"]);
        let granted = grantable_scopes(approved, &requested, &allowed);
        assert_eq!(granted, vec!["patient/Observation.r"]);
    }

    #[test]
    fn grantable_grants_non_canonical_letter_order() {
        // The parser is letter-set based, so a request spelled `.sr` covers an
        // approval spelled `.rs` (same interaction set); the approved wire
        // spelling is returned verbatim.
        let approved = vec!["patient/Observation.rs".to_string()];
        let requested = s(&["patient/Observation.sr"]);
        let allowed = s(&["patient/*.cruds"]);
        let granted = grantable_scopes(approved, &requested, &allowed);
        assert_eq!(granted, vec!["patient/Observation.rs"]);
    }

    #[test]
    fn grantable_drops_unrequested_resource_scopes() {
        // Only Observation was requested; an approved Condition scope is not
        // covered by anything requested and is dropped.
        let approved = vec![
            "patient/Observation.r".to_string(),
            "patient/Condition.r".to_string(),
        ];
        let requested = s(&["patient/Observation.r"]);
        let allowed = s(&["patient/*.cruds"]);
        let granted = grantable_scopes(approved, &requested, &allowed);
        assert_eq!(granted, vec!["patient/Observation.r"]);
    }

    #[test]
    fn grantable_bridges_letter_over_word_asymmetrically() {
        // `Scope::covers` bridges grammars one way (letter covers word, not the
        // reverse — see the `v1_and_v2_perms_cross_cover_letter_over_word_only`
        // test in `scope`).
        let allowed = s(&["patient/*.cruds"]);

        // A v1 *word* request does not make a v2 *letter* approval grantable — a
        // word grant never reaches into letter-grammar access.
        let word_requested_letter_approved = grantable_scopes(
            vec!["patient/Observation.rs".to_string()],
            &s(&["patient/Observation.read"]),
            &allowed,
        );
        assert!(word_requested_letter_approved.is_empty());

        // But a v2 *letter* request covers the equivalent v1 *word* approval, and
        // the approved word spelling is returned verbatim.
        let letter_requested_word_approved = grantable_scopes(
            vec!["patient/Observation.read".to_string()],
            &s(&["patient/Observation.rs"]),
            &allowed,
        );
        assert_eq!(
            letter_requested_word_approved,
            vec!["patient/Observation.read".to_string()]
        );
    }

    #[test]
    fn grantable_known_scopes_match_exactly_not_by_coverage() {
        // Known/flag scopes have no subset structure — coverage collapses to
        // equality, so `openid` grants only against a requested `openid`.
        let granted = grantable_scopes(
            vec!["openid".to_string()],
            &s(&["openid"]),
            &s(&["openid", "offline_access"]),
        );
        assert_eq!(granted, vec!["openid"]);

        let mismatch = grantable_scopes(
            vec!["openid".to_string()],
            &s(&["offline_access"]),
            &s(&["openid", "offline_access"]),
        );
        assert!(mismatch.is_empty());
    }

    #[test]
    fn grantable_allowed_clamp_still_applies_under_coverage() {
        // Requested and Owner-approved a narrowed `.s`, but the client's
        // `allowed_scopes` only permit `.r` — the `allowed` clamp drops it even
        // though the requested side now matches by coverage.
        let granted = grantable_scopes(
            vec!["patient/Observation.s".to_string()],
            &s(&["patient/Observation.rs"]),
            &s(&["patient/*.r"]),
        );
        assert!(granted.is_empty());
    }

    /// `&[&str]` → `Vec<String>` for the twin-expansion cases below.
    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn alternates_added_for_v1_word_resource_scopes() {
        assert_eq!(
            with_alternate_canonical_forms(&v(&["patient/Observation.read"])),
            v(&["patient/Observation.read", "patient/Observation.rs"])
        );
        assert_eq!(
            with_alternate_canonical_forms(&v(&["patient/Observation.write"])),
            v(&["patient/Observation.write", "patient/Observation.cud"])
        );
        assert_eq!(
            with_alternate_canonical_forms(&v(&["system/*.*"])),
            v(&["system/*.*", "system/*.cruds"])
        );
    }

    #[test]
    fn no_alternate_for_letter_forms_and_non_resource_scopes() {
        // Already-letter resource scopes have no distinct alternate.
        assert_eq!(
            with_alternate_canonical_forms(&v(&["patient/Observation.rs"])),
            v(&["patient/Observation.rs"])
        );
        assert_eq!(
            with_alternate_canonical_forms(&v(&["system/*.cruds"])),
            v(&["system/*.cruds"])
        );
        // Known/unknown scopes are passed through untouched.
        assert_eq!(
            with_alternate_canonical_forms(&v(&["openid", "offline_access", "launch/patient"])),
            v(&["openid", "offline_access", "launch/patient"])
        );
        // A v1-worded wildflower string parses as Unknown (the word grammar is
        // FHIR-only), so it gains no alternate.
        assert_eq!(
            with_alternate_canonical_forms(&v(&["wildflower/Grant.read"])),
            v(&["wildflower/Grant.read"])
        );
    }

    #[test]
    fn alternate_expansion_is_idempotent_and_deduplicates_existing_alternates() {
        let once = with_alternate_canonical_forms(&v(&["patient/Observation.read"]));
        assert_eq!(with_alternate_canonical_forms(&once), once);
        // A grant that already carries both forms gains nothing.
        assert_eq!(
            with_alternate_canonical_forms(&v(&[
                "patient/Observation.read",
                "patient/Observation.rs"
            ])),
            v(&["patient/Observation.read", "patient/Observation.rs"])
        );
    }

    #[test]
    fn alternates_preserve_order_in_a_typical_smart_grant() {
        // The growth-chart grant: OIDC + launch + v1 patient reads. Each v1
        // resource read gains its letter-form alternate right after it;
        // everything else is untouched and in order.
        assert_eq!(
            with_alternate_canonical_forms(&v(&[
                "openid",
                "launch/patient",
                "patient/Observation.read",
                "patient/Patient.read",
                "offline_access"
            ])),
            v(&[
                "openid",
                "launch/patient",
                "patient/Observation.read",
                "patient/Observation.rs",
                "patient/Patient.read",
                "patient/Patient.rs",
                "offline_access"
            ])
        );
    }
}
