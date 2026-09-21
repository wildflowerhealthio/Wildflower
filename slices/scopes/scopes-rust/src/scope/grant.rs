//! A [`Grant`] — an ordered collection of [`Scope`]s, the structured form of the
//! scope lists stored in client `allowed_scopes` / grant rows and minted into a
//! token's space-joined `scope` claim.
//!
//! The sibling modules model one scope each; a `Grant` is the whole *set*, with
//! the collection-level operations — render, coverage, kind projections —
//! callers would otherwise open-code over a `&[Scope]`. It mirrors `scopes-core`'s
//! `domain/grant.ts`.

use crate::scope::{KnownScope, Scope};

/// An ordered collection of [`Scope`]s — a parsed grant. Order is preserved so a
/// grant round-trips through [`parse`](Grant::parse) → [`render`](Grant::render)
/// in the spelling it was given.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Grant {
    /// The grant's scopes, in their original order.
    pub scopes: Vec<Scope>,
}

impl Grant {
    /// A grant over the given scopes.
    pub fn new(scopes: Vec<Scope>) -> Self {
        Self { scopes }
    }

    /// Parse a list of scope strings into a grant. Total — each string parses to
    /// its richest [`Scope`], falling back to [`Unknown`](Scope::Unknown), so no
    /// input is ever dropped.
    pub fn parse<I, S>(raw: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        Self::new(raw.into_iter().map(|s| Scope::from(s.as_ref())).collect())
    }

    /// Render every scope to its canonical wire string (SMART v1↔v2 back-compat —
    /// see [`Permission`](crate::Permission)). The list-level counterpart of
    /// [`Scope`]'s [`Display`](std::fmt::Display); shares [`render_scopes`](crate::render_scopes).
    pub fn render(&self) -> Vec<String> {
        crate::render_scopes(&self.scopes)
    }

    /// Does any scope in this grant cover `scope`? This is the coverage test a
    /// client's `allowed_scopes` are run through when deciding what an approval
    /// may grant (see [`Scope::covers`]).
    pub fn covers(&self, scope: &Scope) -> bool {
        self.scopes.iter().any(|s| s.covers(scope))
    }

    /// The `required` scopes this grant does **not** cover, preserving the order
    /// given — empty iff the grant covers every one. The list a per-resource gate
    /// renders into an `InsufficientScope` 403's `missingScopes`: e.g. the apps
    /// slice's per-app launch check names the SMART scopes a caller lacks for a
    /// specific app. Pairs with [`covers_all`](Grant::covers_all), which is the
    /// same test as a bool.
    pub fn missing_scopes(&self, required: &[Scope]) -> Vec<Scope> {
        required
            .iter()
            .filter(|scope| !self.covers(scope))
            .cloned()
            .collect()
    }

    /// Whether this grant covers **every** scope in `required` (vacuously true for
    /// an empty `required`). The bool form of [`missing_scopes`](Grant::missing_scopes).
    pub fn covers_all(&self, required: &[Scope]) -> bool {
        required.iter().all(|scope| self.covers(scope))
    }

    /// Fold `additional` into this grant and collapse the result
    /// ([`collapse`](Grant::collapse)) — the structured form of "widen a stored
    /// scope list by what was just approved". Granting again what is already
    /// held is a no-op, and a broader addition *replaces* the narrower entries
    /// it supersedes rather than sitting alongside them: widening
    /// `[patient/Patient.r]` by `[patient/Patient.cruds]` leaves
    /// `[patient/Patient.cruds]`, not both.
    ///
    /// The result reaches exactly the interactions the two lists reached between
    /// them — never a resource, context or interaction neither granted — which is
    /// what makes it safe on an authorization ceiling such as a client's
    /// `allowed_scopes`. It is not string-for-string conservative: see
    /// [`collapse`](Grant::collapse) for the one way a merged scope admits a
    /// spelling the pair did not.
    pub fn widen(&mut self, additional: &Grant) {
        self.scopes.extend(additional.scopes.iter().cloned());
        self.collapse();
    }

    /// Reduce this grant to the shortest list granting exactly the same access:
    /// [merge](merge_restatable) what can be restated as one scope, then
    /// [drop](without_subsumed) what a broader survivor already admits.
    ///
    /// Order is first-occurrence, so widening appends only what is genuinely new,
    /// and the result is idempotent — collapsing twice changes nothing.
    ///
    /// **What a merge costs.** The interactions a collapsed grant reaches are
    /// exactly those the original reached; the *spellings* it admits are a
    /// superset. `patient/Patient.r` and `patient/Patient.s` together admit
    /// neither's combination, but the merged `patient/Patient.rs` admits a
    /// literal `.rs` request — and likewise `read ∪ write = *` admits a literal
    /// `.*`. Such a request asks for nothing the grant did not already confer
    /// interaction-by-interaction, which is why this is a restatement and not a
    /// widening. Merging *across* grammars would break that, and is refused
    /// ([`Permission::union`](crate::Permission)).
    pub fn collapse(&mut self) {
        self.scopes = without_subsumed(merge_restatable(std::mem::take(&mut self.scopes)));
    }

    /// The structured FHIR/Wildflower resource scopes in the grant.
    pub fn resource_scopes(&self) -> impl Iterator<Item = &Scope> + '_ {
        self.scopes
            .iter()
            .filter(|s| matches!(s, Scope::FhirResource(_) | Scope::WildflowerResource(_)))
    }

    /// The broadly-known (flag) scopes in the grant, e.g. `openid` / `offline_access`.
    pub fn known_scopes(&self) -> impl Iterator<Item = KnownScope> + '_ {
        self.scopes.iter().filter_map(|s| match s {
            Scope::Known(k) => Some(*k),
            _ => None,
        })
    }

    /// Whether the grant holds a given flag scope.
    pub fn has_known(&self, flag: KnownScope) -> bool {
        self.known_scopes().any(|k| k == flag)
    }
}

/// [`collapse`](Grant::collapse) pass 1 — fold every scope into the first
/// earlier one it can be *restated* with ([`Scope::merged`]: the same
/// context/resource in the same permission grammar, or an identical twin, which
/// is how plain duplicates disappear). A scope that merges with nothing stands
/// on its own. The merged scope keeps the earlier member's position, so the
/// result is in first-occurrence order.
fn merge_restatable(scopes: Vec<Scope>) -> Vec<Scope> {
    let mut kept_scopes: Vec<Scope> = Vec::with_capacity(scopes.len());
    for scope in scopes {
        let maybe_merged = kept_scopes.iter_mut().find_map(|already_kept_scope_ref| {
            let maybe_merged = already_kept_scope_ref.merged(&scope);
            maybe_merged.map(|merged| (already_kept_scope_ref, merged))
        });
        match maybe_merged {
            Some((kept_scope_ref, newly_merged_scope)) => *kept_scope_ref = newly_merged_scope,
            None => kept_scopes.push(scope),
        }
    }
    kept_scopes
}

/// [`collapse`](Grant::collapse) pass 2 — drop every scope that some *other*
/// scope strictly covers, leaving only the maximal ones. A `patient/*.cruds`
/// wildcard absorbs the `patient/Observation.r` beneath it, and a v2 `.cruds`
/// absorbs the v1 `.read` it covers.
fn without_subsumed(scopes: Vec<Scope>) -> Vec<Scope> {
    scopes
        .iter()
        .filter(|scope| !scopes.iter().any(|other| strictly_covers(other, scope)))
        .cloned()
        .collect()
}

/// Whether `broader` admits everything `narrower` does *and* something more.
///
/// The strictness is load-bearing for [`without_subsumed`]: under plain
/// [`covers`](Scope::covers) a scope would strike itself out, and two equivalent
/// scopes would strike each other out, emptying the grant. Requiring coverage in
/// one direction only means every equivalence class keeps a member.
fn strictly_covers(broader: &Scope, narrower: &Scope) -> bool {
    broader.covers(narrower) && !narrower.covers(broader)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_renders_round_trips_each_scope_in_order() {
        let raw = [
            "openid",
            "patient/Observation.rs",
            "wildflower/Grant.cruds",
            "a_stray_unknown",
        ];
        let grant = Grant::parse(raw);
        // Each string parsed to a Scope (none dropped) and renders back verbatim,
        // in the original order.
        assert_eq!(grant.scopes.len(), 4);
        assert_eq!(grant.render(), raw);
    }

    #[test]
    fn covers_delegates_to_any_member_scope() {
        // A `system/*.cruds` member covers a specific narrower request — including
        // other *contexts*, since `system` covers every context...
        let grant = Grant::parse(["system/*.cruds", "openid"]);
        assert!(grant.covers(&Scope::from("system/Patient.r")));
        assert!(grant.covers(&Scope::from("user/Patient.r")));
        assert!(grant.covers(&Scope::from("patient/Observation.r")));
        assert!(grant.covers(&Scope::from("openid")));
        // ...but a narrower context never reaches up, and an unrequested flag is out.
        assert!(!Grant::parse(["patient/*.cruds"]).covers(&Scope::from("user/Patient.r")));
        assert!(!grant.covers(&Scope::from("offline_access")));
        // The empty grant covers nothing.
        assert!(!Grant::default().covers(&Scope::from("openid")));
    }

    #[test]
    fn missing_scopes_names_only_the_uncovered_in_order() {
        // A wildcard covers the resource read; the launch known scope and a
        // narrower FHIR read are absent, so both come back in the order asked.
        let grant = Grant::parse(["wildflower/*.cruds"]);
        let required = [
            Scope::from("wildflower/Apps.r"),
            Scope::any_scoped_app_launch(),
            Scope::from("system/Observation.r"),
        ];
        assert_eq!(
            grant.missing_scopes(&required),
            vec![
                Scope::any_scoped_app_launch(),
                Scope::from("system/Observation.r"),
            ],
        );
        assert!(!grant.covers_all(&required));

        // Empty requirement is vacuously covered; a fully-covered set is empty.
        assert!(grant.covers_all(&[]));
        assert!(grant.missing_scopes(&[]).is_empty());
        let covered = [Scope::from("wildflower/Apps.r")];
        assert!(grant.covers_all(&covered));
        assert!(grant.missing_scopes(&covered).is_empty());
    }

    /// Widen `standing` by `additional` and read back the wire strings.
    fn widened(standing: &[&str], additional: &[&str]) -> Vec<String> {
        let mut grant = Grant::parse(standing);
        grant.widen(&Grant::parse(additional));
        grant.render()
    }

    /// The case that motivates the collapse: an approval that grants the whole
    /// resource must *replace* the narrower entry, not sit beside it.
    #[test]
    fn widening_replaces_a_narrower_entry_with_the_broader_grant() {
        assert_eq!(
            widened(&["patient/Patient.r", "openid"], &["patient/Patient.cruds"]),
            ["patient/Patient.cruds", "openid"]
        );
        // The merged scope keeps the replaced entry's position — `openid` is not
        // shuffled by a widening that never touched it.
    }

    #[test]
    fn widening_by_an_already_covered_scope_changes_nothing() {
        let standing = ["patient/*.cruds", "openid"];
        assert_eq!(
            widened(&standing, &["patient/Observation.r", "openid"]),
            standing
        );
    }

    #[test]
    fn widening_unions_the_interactions_of_one_resource() {
        // Neither covers the other, but both address `patient/Patient` in the
        // letter grammar, so they restate as one scope.
        assert_eq!(
            widened(&["patient/Patient.r"], &["patient/Patient.s"]),
            ["patient/Patient.rs"]
        );
        // Within the v1 word grammar the union lands on `*` (the only word
        // spelling of `read ∪ write`), staying in the grammar it started in.
        assert_eq!(
            widened(&["patient/Patient.read"], &["patient/Patient.write"]),
            ["patient/Patient.*"]
        );
    }

    /// The grammar guard: a v1 word and a v2 letter bag never fold together, so
    /// a word-registered entry can't be turned into letter-grammar access it
    /// never had. Subsumption still crosses the grammars one way.
    #[test]
    fn widening_never_merges_a_v1_word_into_a_letter_bag() {
        // `.read` (word) and `.c` (letter) each grant what the other doesn't;
        // folding them to `.crs` would newly hand over letter `r`/`s`.
        assert_eq!(
            widened(&["patient/Patient.read"], &["patient/Patient.c"]),
            ["patient/Patient.read", "patient/Patient.c"]
        );
        // But `.cruds` *covers* `.read`, so it absorbs it outright.
        assert_eq!(
            widened(&["patient/Patient.read"], &["patient/Patient.cruds"]),
            ["patient/Patient.cruds"]
        );
        // And the reverse never happens — a word grant can't swallow a letter one.
        assert_eq!(
            widened(&["patient/Patient.cruds"], &["patient/Patient.*"]),
            ["patient/Patient.cruds"]
        );
    }

    /// A wildcard or a broader context absorbs what it subsumes, but the two are
    /// never *merged* into one — `system` and `user` stay distinct spellings
    /// unless one genuinely covers the other.
    #[test]
    fn widening_absorbs_across_resources_and_contexts_by_coverage() {
        assert_eq!(
            widened(
                &["patient/Observation.r", "patient/Condition.rs"],
                &["patient/*.cruds"]
            ),
            ["patient/*.cruds"]
        );
        assert_eq!(
            widened(&["user/Patient.r"], &["system/Patient.cruds"]),
            ["system/Patient.cruds"]
        );
        // `user` does not reach `patient`, so neither absorbs the other.
        assert_eq!(
            widened(&["user/Patient.r"], &["patient/Patient.r"]),
            ["user/Patient.r", "patient/Patient.r"]
        );
    }

    #[test]
    fn collapse_drops_duplicates_including_unparseable_ones() {
        let mut grant = Grant::parse([
            "openid",
            "a_stray_unknown",
            "openid",
            "wildflower/Grant.r",
            "a_stray_unknown",
            "wildflower/Grant.u",
        ]);
        grant.collapse();
        assert_eq!(
            grant.render(),
            ["openid", "a_stray_unknown", "wildflower/Grant.ru"]
        );
    }

    /// Collapsing is idempotent, and widening by what a grant already holds is a
    /// no-op — the property the repeated-approval path relies on.
    #[test]
    fn collapse_is_idempotent_and_widening_is_stable() {
        let raw = [
            "patient/*.cruds",
            "patient/Observation.r",
            "patient/Patient.read",
            "openid",
            "openid",
        ];
        let mut once = Grant::parse(raw);
        once.collapse();
        let mut twice = once.clone();
        twice.collapse();
        assert_eq!(twice.render(), once.render());

        let mut rewidened = once.clone();
        rewidened.widen(&Grant::parse(raw));
        assert_eq!(rewidened.render(), once.render());
    }

    /// The safety property, stated on **interactions** rather than on spellings:
    /// collapsing grants no interaction on any resource that wasn't granted
    /// before, and loses none either.
    ///
    /// Coverage of whole scope *strings* is deliberately not preserved — that is
    /// what merging buys. Folding `.r` and `.s` into `.rs` makes a literal `.rs`
    /// request admissible where the pair admitted only `.r` and `.s` separately,
    /// and `read ∪ write = *` does the same in the word grammar. The interactions
    /// reachable are identical either way, which is the invariant that matters
    /// for an authorization ceiling.
    #[test]
    fn collapse_preserves_exactly_the_interactions_granted() {
        let raw = [
            "patient/Patient.r",
            "patient/Patient.s",
            "patient/Observation.read",
            "patient/Observation.write",
            "patient/*.c",
            "user/Patient.cruds",
            "wildflower/Grant.r",
            "wildflower/*.u",
            "openid",
            "a_stray_unknown",
        ];
        let before = Grant::parse(raw);
        let mut after = before.clone();
        after.collapse();

        // Nothing was lost: every input scope is still admitted.
        for scope in &before.scopes {
            assert!(after.covers(scope), "collapse dropped {scope}");
        }

        // Nothing was gained: the single-interaction atoms — one letter, one
        // concrete resource — are the grant's reachable access, and they match
        // exactly. (A v1 word grant covers no letter atom at all, by the
        // `Permission::contains` asymmetry, so the word-form merges register here
        // as granting nothing new, which is precisely the claim.)
        let atoms = ["c", "r", "u", "d", "s"];
        let fhir = ["patient", "user", "system"]
            .into_iter()
            .flat_map(|context| {
                ["Patient", "Observation", "Condition"]
                    .into_iter()
                    .map(move |resource| format!("{context}/{resource}"))
            });
        let wildflower = ["Grant", "Client", "Token"]
            .into_iter()
            .map(|resource| format!("wildflower/{resource}"));
        for prefix in fhir.chain(wildflower) {
            for atom in atoms {
                let probe = Scope::from(format!("{prefix}.{atom}").as_str());
                assert_eq!(
                    after.covers(&probe),
                    before.covers(&probe),
                    "collapse changed access to {probe}"
                );
            }
        }
    }

    #[test]
    fn projections_split_scopes_by_kind() {
        let grant = Grant::parse([
            "openid",
            "offline_access",
            "patient/Observation.rs",
            "wildflower/Grant.cruds",
            "a_stray_unknown",
        ]);
        assert_eq!(grant.resource_scopes().count(), 2);
        assert_eq!(
            grant.known_scopes().collect::<Vec<_>>(),
            vec![KnownScope::Openid, KnownScope::OfflineAccess]
        );
        assert!(grant.has_known(KnownScope::Openid));
        assert!(!grant.has_known(KnownScope::FhirUser));
    }
}
