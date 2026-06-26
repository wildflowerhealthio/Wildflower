//! Shared machinery for the two Owner consent surfaces —
//! `/oauth-consents/{id}` (authorization-code flow) and `/devices/{userCode}`
//! (device-code flow, RFC 8628). The two differ in how they load a pending
//! request, and the code flow additionally mints an authorization code on
//! approval; but they agree on the wire shapes the Owner UI posts and reads
//! ([`ApproveBody`], [`ConsentResult`]), on the rule for which scopes an
//! approval may actually grant ([`grantable_scopes`]), and on the deny path
//! ([`deny_consent`]). Keeping those here stops the two trees from drifting —
//! the divergence that once let the device path skip the `allowed_scopes`
//! clamp the code path already had.

use std::collections::HashSet;

use axum::Json;
use serde::{Deserialize, Serialize};

use crate::http::response_templates::HandlerError;
use crate::http::state::AppState;

/// Body posted by the Owner UI to approve a consent prompt: the scopes the
/// Owner ticked, plus an optional patient context to bind to the grant. The
/// device flow sends no `patient` today, so it deserializes to `None`; the
/// field is shared in anticipation of device-flow patient selection.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApproveBody {
    pub(crate) approved_scopes: Vec<String>,
    pub(crate) patient: Option<String>,
}

/// Result the Owner UI sees after approving or denying a consent prompt.
#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub(crate) enum ConsentResult {
    Approved,
    Denied,
}

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
pub(crate) fn grantable_scopes(
    approved: Vec<String>,
    requested: &HashSet<&str>,
    allowed: &HashSet<&str>,
) -> Vec<String> {
    approved
        .into_iter()
        .filter(|s| {
            requested.contains(s.as_str()) && allowed.iter().any(|a| allowed_scope_covers(a, s))
        })
        .collect()
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
fn smart_permission_bits(perms: &str) -> Option<u8> {
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
fn allowed_scope_covers(allowed: &str, requested: &str) -> bool {
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
        assert!(allowed_scope_covers("patient/Patient.read", "patient/Patient.rs"));
        // v1 request covered by a v2 `cruds` allow-scope.
        assert!(allowed_scope_covers(
            "patient/Patient.cruds",
            "patient/Patient.read"
        ));
        // v1 `*` (all permissions) covers any request, including across the
        // resource-type wildcard.
        assert!(allowed_scope_covers("patient/Patient.*", "patient/Patient.cruds"));
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
}

/// Mark the pending request `request_id` denied and return the Owner-UI
/// result. Each flow loads/validates the request with its own loader first,
/// then funnels both the explicit-deny route and the nothing-granted route of
/// `approve` through here, so the deny side stays identical across both trees.
///
/// Also republishes the active device-consent head: a device-flow deny
/// may have just resolved the popup's head, so the modal needs to close
/// (or jump to the next queued request). Code-flow denies are no-ops
/// against the device-only query, so the call is safe to make here
/// unconditionally rather than threading a `grant_type` argument.
pub(crate) fn deny_consent(
    state: &AppState,
    request_id: &str,
) -> Result<Json<ConsentResult>, HandlerError> {
    state
        .store
        .deny_authorization_request(request_id)
        .map_err(|e| HandlerError::internal("deny_authorization_request failed", e))?;
    state.republish_active_device_user_code();
    Ok(Json(ConsentResult::Denied))
}
