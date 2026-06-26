//! The SMART on FHIR scope grammar: parsing `context/type.perms` scopes,
//! normalizing SMART v1 *word* permissions (`read`/`write`/`*`) and v2
//! *letter* bags (`rs`/`cud`/`cruds`) to a common CRUDS bit set, deciding
//! whether one scope covers another, and computing the scopes an Owner
//! approval may actually grant ([`grantable_scopes`]).

use std::collections::HashSet;

/// The scopes an Owner approval can actually grant: those that are both still
/// requested by the pending request and covered by the client's *current*
/// `allowed_scopes`. The Owner can only narrow, never widen, and the `allowed`
/// clamp stops a stale request from granting a scope the client's policy no
/// longer permits.
///
/// "Covered by allowed" means either an exact-string match, or that some
/// SMART v2 scope in `allowed` is a superset of the approved scope (a
/// wildcard type, broader permission bits, or both). See
/// [`allowed_scope_covers`].
///
/// Each granted SMART v1 *word* scope (`.read`/`.write`/`.*`) additionally
/// yields its v2 *letter* equivalent (`patient/Observation.read` also grants
/// `patient/Observation.rs`). The word form is what clients request and the
/// consent UI shows, but HFS's scope policy only enforces the letter form, so
/// the minted token must carry both for the FHIR surface to honour the grant.
/// See [`letter_scope_equivalent`]. The extras are appended (never
/// substituted) and de-duplicated, so an already-letter grant is unchanged and
/// the empty grant stays empty (the approve handlers treat "nothing granted"
/// as a deny).
pub fn grantable_scopes(
    approved: Vec<String>,
    requested: &HashSet<&str>,
    allowed: &HashSet<&str>,
) -> Vec<String> {
    let mut granted: Vec<String> = approved
        .into_iter()
        .filter(|s| {
            requested.contains(s.as_str()) && allowed.iter().any(|a| allowed_scope_covers(a, s))
        })
        .collect();

    let mut letter_extras: Vec<String> = Vec::new();
    for scope in &granted {
        if let Some(letters) = letter_scope_equivalent(scope) {
            if !granted.contains(&letters) && !letter_extras.contains(&letters) {
                letter_extras.push(letters);
            }
        }
    }
    granted.extend(letter_extras);
    granted
}

/// CRUDS permission bits, mirroring helios-auth's `SmartPermissions`
/// (`c`reate, `r`ead, `u`pdate, `d`elete, `s`earch). We compare permission
/// segments by set membership, not raw substring, so the v1 word `read`
/// can't be misread as the v2 letter bag `{r, e, a, d}`.
const PERM_CREATE: u8 = 0b0_0001;
const PERM_READ: u8 = 0b0_0010;
const PERM_UPDATE: u8 = 0b0_0100;
const PERM_DELETE: u8 = 0b0_1000;
const PERM_SEARCH: u8 = 0b1_0000;

/// Normalize a SMART scope permission segment into a CRUDS bit set,
/// accepting both SMART v2 letter bags (`rs`, `cruds`) and the SMART v1
/// permission words (`read`, `write`, `*`). Returns `None` for an empty or
/// unrecognized segment (e.g. a v2 bag with a stray letter like `read`'s
/// `e`/`a`, which is *not* a valid v2 perm set).
///
/// The v1 → v2 mapping follows the SMART App Launch back-compat rule:
/// `read` = read + search (`rs`), `write` = create + update + delete
/// (`cud`), `*` = all (`cruds`).
pub fn smart_permission_bits(perms: &str) -> Option<u8> {
    match perms {
        "read" => return Some(PERM_READ | PERM_SEARCH),
        "write" => return Some(PERM_CREATE | PERM_UPDATE | PERM_DELETE),
        "*" => return Some(PERM_CREATE | PERM_READ | PERM_UPDATE | PERM_DELETE | PERM_SEARCH),
        _ => {}
    }
    let mut bits = 0u8;
    for ch in perms.chars() {
        bits |= match ch {
            'c' => PERM_CREATE,
            'r' => PERM_READ,
            'u' => PERM_UPDATE,
            'd' => PERM_DELETE,
            's' => PERM_SEARCH,
            _ => return None,
        };
    }
    (bits != 0).then_some(bits)
}

/// Does the client-allowed scope `allowed` cover the approved scope
/// `requested`? Exact-string match always wins; otherwise, both sides are
/// parsed as SMART (`context/type.perms`) and `allowed` is treated as a
/// superset when:
///
/// * contexts match exactly, AND
/// * `allowed`'s resource type is `*` or matches `requested`'s, AND
/// * every permission `requested` grants is also granted by `allowed`.
///
/// Permission segments are normalized through [`smart_permission_bits`], so
/// a v1 word (`read`/`write`/`*`) on either side is compared as the CRUDS
/// set it denotes rather than as raw characters — `patient/Observation.read`
/// (allowed) no longer "covers" `patient/Observation.d` (delete), and a v2
/// request like `patient/Observation.rs` is correctly covered by a v1
/// `patient/Observation.read`.
///
/// Non-SMART scopes (`offline_access`, `wildflower/admin`, `openid`,
/// `launch`, …) only match exactly — the exact-string check up front. This
/// is the "wrapper" approach to SMART scopes: clients can register
/// wildcards like `system/*.cruds`, but the intersection stays
/// string-set-shaped without pulling in a full scope grammar parser.
pub fn allowed_scope_covers(allowed: &str, requested: &str) -> bool {
    if allowed == requested {
        return true;
    }
    let Some((req_ctx, req_rest)) = requested.split_once('/') else {
        return false;
    };
    let Some((req_type, req_perms)) = req_rest.split_once('.') else {
        return false;
    };
    let Some((allow_ctx, allow_rest)) = allowed.split_once('/') else {
        return false;
    };
    let Some((allow_type, allow_perms)) = allow_rest.split_once('.') else {
        return false;
    };
    if req_ctx != allow_ctx {
        return false;
    }
    if allow_type != "*" && allow_type != req_type {
        return false;
    }
    let (Some(req_bits), Some(allow_bits)) = (
        smart_permission_bits(req_perms),
        smart_permission_bits(allow_perms),
    ) else {
        return false;
    };
    // `allowed` covers `requested` only when every requested permission bit
    // is also present in `allowed` (i.e. `requested` is a subset).
    req_bits & !allow_bits == 0
}

/// Render a CRUDS bit set back to canonical letter order (`c`, `r`, `u`, `d`,
/// `s`), e.g. `READ | SEARCH` -> `"rs"`. Inverse of the letter half of
/// [`smart_permission_bits`].
pub fn render_permission_bits(bits: u8) -> String {
    let mut out = String::with_capacity(5);
    for (bit, ch) in [
        (PERM_CREATE, 'c'),
        (PERM_READ, 'r'),
        (PERM_UPDATE, 'u'),
        (PERM_DELETE, 'd'),
        (PERM_SEARCH, 's'),
    ] {
        if bits & bit != 0 {
            out.push(ch);
        }
    }
    out
}

/// If `scope` is a SMART resource scope whose permission segment is a v1 word
/// (`read`/`write`/`*`), return the equivalent v2 letter scope
/// (`context/type.<letters>`). Returns `None` when `scope` isn't a SMART
/// resource scope (`offline_access`, `wildflower/admin`, …) or its permissions
/// are already in letter form — a letter segment maps to itself, so there's
/// nothing to add.
pub fn letter_scope_equivalent(scope: &str) -> Option<String> {
    let (ctx, rest) = scope.split_once('/')?;
    let (rtype, perms) = rest.split_once('.')?;
    let letters = render_permission_bits(smart_permission_bits(perms)?);
    (letters != perms).then(|| format!("{ctx}/{rtype}.{letters}"))
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
        assert!(allowed_scope_covers("wildflower/admin", "wildflower/admin"));
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
        // No `/` or `.` in `offline_access`, so the SMART parse short-circuits.
        assert!(!allowed_scope_covers("system/*.cruds", "offline_access"));
        assert!(!allowed_scope_covers("offline_access", "system/Patient.r"));
    }

    #[test]
    fn v1_word_perms_map_to_their_letter_sets() {
        // `read` = read + search. The old char-bag check let `.read` (the
        // string `r,e,a,d`) cover `.d` (delete); the set mapping does not.
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
        // `write` = create + update + delete.
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
        // v2 request covered by a v1 `read` allow-scope.
        assert!(allowed_scope_covers(
            "patient/Patient.read",
            "patient/Patient.rs"
        ));
        // v1 request covered by a v2 `cruds` allow-scope.
        assert!(allowed_scope_covers(
            "patient/Patient.cruds",
            "patient/Patient.read"
        ));
        // v1 `*` (all permissions) covers any request, including across the
        // resource-type wildcard.
        assert!(allowed_scope_covers(
            "patient/Patient.*",
            "patient/Patient.cruds"
        ));
        assert!(allowed_scope_covers("patient/*.*", "patient/Observation.d"));
    }

    #[test]
    fn invalid_perm_segments_reject() {
        // A stray non-CRUDS letter makes the whole segment unparseable on
        // either side — no silent substring match.
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
    fn letter_equivalent_maps_v1_words_only() {
        assert_eq!(
            letter_scope_equivalent("patient/Observation.read").as_deref(),
            Some("patient/Observation.rs")
        );
        assert_eq!(
            letter_scope_equivalent("patient/Observation.write").as_deref(),
            Some("patient/Observation.cud")
        );
        assert_eq!(
            letter_scope_equivalent("patient/*.*").as_deref(),
            Some("patient/*.cruds")
        );
        // Already letter-form, non-SMART, or unparseable → nothing to add.
        assert_eq!(letter_scope_equivalent("system/Patient.rs"), None);
        assert_eq!(letter_scope_equivalent("offline_access"), None);
        assert_eq!(letter_scope_equivalent("patient/Observation.xyz"), None);
    }

    #[test]
    fn grantable_adds_letter_equivalent_for_word_scopes() {
        // The growth-chart case: a v1 `.read` scope is granted and its v2
        // letter form is appended so HFS's scope policy can enforce it.
        let approved = vec!["patient/Observation.read".to_string()];
        let requested = s(&["patient/Observation.read"]);
        let allowed = s(&["patient/Observation.read"]);
        let granted = grantable_scopes(approved, &requested, &allowed);
        assert_eq!(
            granted,
            vec!["patient/Observation.read", "patient/Observation.rs"]
        );
    }

    #[test]
    fn grantable_maps_write_and_wildcard_words() {
        let approved = vec![
            "patient/Observation.write".to_string(),
            "patient/Patient.*".to_string(),
        ];
        let requested = s(&["patient/Observation.write", "patient/Patient.*"]);
        let allowed = s(&["patient/*.*"]);
        let granted = grantable_scopes(approved, &requested, &allowed);
        assert_eq!(
            granted,
            vec![
                "patient/Observation.write",
                "patient/Patient.*",
                "patient/Observation.cud",
                "patient/Patient.cruds",
            ]
        );
    }

    #[test]
    fn grantable_does_not_duplicate_existing_letter_form() {
        // Owner approved both the word and the letter form — no third copy.
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
