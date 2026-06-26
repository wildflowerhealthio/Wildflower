//! String-facing entry points to the scope grammar, implemented on top of the
//! structured [`Scope`] model. These keep the
//! `&str`/`Vec<String>` signatures gatekeeper's consent handlers call, parsing
//! to `Scope` internally so coverage and rendering share one implementation.

use std::collections::HashSet;

use crate::scope::Scope;

/// The scopes an Owner approval can actually grant: those that are both still
/// requested by the pending request and covered by the client's *current*
/// `allowed_scopes`. The Owner can only narrow, never widen, and the `allowed`
/// clamp stops a stale request from granting a scope the client's policy no
/// longer permits.
///
/// Membership and coverage are compared **structurally** (each side is parsed to
/// a [`Scope`]), and every kept scope is rendered back to its wire string. SMART
/// v1 word scopes round-trip verbatim — a granted `patient/Observation.read`
/// stays `patient/Observation.read` (the SMART back-compat rule: return v1 when
/// v1 is requested and granted), while v2 letter bags are normalized to canonical
/// order. The result is de-duplicated by rendered form, preserving first-seen
/// order; an empty grant stays empty (the approve handlers treat "nothing
/// granted" as a deny).
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
        let is_requested = requested.contains(&approved_scope);
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

/// Does the client-allowed scope `allowed` cover the approved scope `requested`?
/// Both sides are parsed to a [`Scope`] and compared with [`Scope::covers`]:
/// resource scopes match by context + resource-type (wildcard-aware) + CRUDS
/// subset; known and unknown scopes match exactly.
pub fn allowed_scope_covers(allowed: &str, requested: &str) -> bool {
    Scope::from(allowed).covers(&Scope::from(requested))
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
    fn context_mismatch_rejects() {
        assert!(!allowed_scope_covers("system/*.cruds", "user/Patient.r"));
        assert!(!allowed_scope_covers("patient/*.cruds", "user/Patient.r"));
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
    fn v1_word_perms_map_to_their_letter_sets() {
        assert!(allowed_scope_covers(
            "patient/Observation.read",
            "patient/Observation.r"
        ));
        assert!(allowed_scope_covers(
            "patient/Observation.read",
            "patient/Observation.s"
        ));
        assert!(allowed_scope_covers(
            "patient/Observation.read",
            "patient/Observation.rs"
        ));
        assert!(!allowed_scope_covers(
            "patient/Observation.read",
            "patient/Observation.d"
        ));
        assert!(!allowed_scope_covers(
            "patient/Observation.read",
            "patient/Observation.c"
        ));
        assert!(allowed_scope_covers(
            "patient/Observation.write",
            "patient/Observation.cud"
        ));
        assert!(!allowed_scope_covers(
            "patient/Observation.write",
            "patient/Observation.r"
        ));
    }

    #[test]
    fn v1_and_v2_perms_interoperate_both_directions() {
        assert!(allowed_scope_covers(
            "patient/Patient.read",
            "patient/Patient.rs"
        ));
        assert!(allowed_scope_covers(
            "patient/Patient.cruds",
            "patient/Patient.read"
        ));
        assert!(allowed_scope_covers(
            "patient/Patient.*",
            "patient/Patient.cruds"
        ));
        assert!(allowed_scope_covers("patient/*.*", "patient/Observation.d"));
    }

    #[test]
    fn invalid_perm_segments_reject() {
        // A stray non-CRUDS letter makes the segment unparseable, so the scope
        // is `Unknown` and only matches the identical string.
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
        let allowed = s(&["patient/*.cruds"]);
        let granted = grantable_scopes(approved, &requested, &allowed);
        assert_eq!(
            granted,
            vec!["patient/Observation.read", "patient/Observation.rs"]
        );
    }
}
