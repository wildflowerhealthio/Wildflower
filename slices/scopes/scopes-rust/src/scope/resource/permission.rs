//! Permissions — the access half of every resource scope. The single `cruds`
//! letters are *interactions* (`c`reate, `r`ead, `u`pdate, `d`elete, `s`earch);
//! a [`Permission`] is any set of them, written in either the `.cruds`/`.rs`
//! letter or the `read`/`write`/`*` word grammar. Both grammars follow the SMART
//! App Launch spec:
//! <https://build.fhir.org/ig/HL7/smart-app-launch/scopes-and-launch-context.html>.
//!
//! This deliberately re-implements helios-auth's `SmartPermissions` rather than
//! depending on it. Keeping `scopes-rust` a lean, helios-auth-free leaf crate
//! lets every slice reason about scopes without pulling in helios-auth's
//! transitive graph, and lets this model carry its own SMART v1/v2 handling (the
//! word-vs-letter forms below) without coupling to helios-auth's representation.

use std::fmt;

/// Interaction bits (`c`reate, `r`ead, `u`pdate, `d`elete, `s`earch), mirroring
/// helios-auth's `SmartPermissions`. Permission segments are compared by set
/// membership, not raw substring, so the v1 word `read` can't be misread as the
/// v2 letter bag `{r, e, a, d}`.
const CREATE_INTERACTION_BIT: u8 = 0b0_0001;
const READ_INTERACTION_BIT: u8 = 0b0_0010;
const UPDATE_INTERACTION_BIT: u8 = 0b0_0100;
const DELETE_INTERACTION_BIT: u8 = 0b0_1000;
const SEARCH_INTERACTION_BIT: u8 = 0b1_0000;
const ALL_INTERACTION_BITSTRING: u8 = CREATE_INTERACTION_BIT
    | READ_INTERACTION_BIT
    | UPDATE_INTERACTION_BIT
    | DELETE_INTERACTION_BIT
    | SEARCH_INTERACTION_BIT;

/// The five interactions in canonical `c,r,u,d,s` order, each paired with its
/// bit — the one source of truth shared by letter-bag parsing and rendering.
const INTERACTIONS: [(u8, char); 5] = [
    (CREATE_INTERACTION_BIT, 'c'),
    (READ_INTERACTION_BIT, 'r'),
    (UPDATE_INTERACTION_BIT, 'u'),
    (DELETE_INTERACTION_BIT, 'd'),
    (SEARCH_INTERACTION_BIT, 's'),
];

/// A non-empty set of interactions — the permission half of every resource scope.
///
/// Coverage never crosses grammars: v1 words compare only against v1 words and
/// v2 letter bags only against letter bags (within a grammar the comparison is
/// by interaction bit set). This mirrors scopes-core's no-cross-style-conversion
/// invariant — a client registered in one grammar authorizes requests in that
/// grammar only. The SMART v1 *word* forms (`read`/`write`/`*`) are preserved so
/// they round-trip: per the SMART App Launch v1↔v2 back-compat rule, a grant
/// requested as `read` is returned as `read` (not its `rs` letter equivalent).
/// v2 letter bags render in canonical `c,r,u,d,s` order regardless of input
/// order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Permission(PermissionRepr);

/// Private representation: the three SMART v1 words kept verbatim for round-trip,
/// plus the v2 letter-bag bit set. Two values are equal iff they share this
/// representation — so `read` and `rs` are distinct (they render differently)
/// even though they cover the same interactions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum PermissionRepr {
    /// SMART v1 `read` (= `rs`).
    Read,
    /// SMART v1 `write` (= `cud`).
    Write,
    /// SMART v1 `*` (= `cruds`).
    Star,
    /// A v2 letter bag (canonical, non-empty).
    InteractionSet(u8),
}

impl Permission {
    /// Every interaction, as the canonical v2 `cruds` letter bag.
    pub const ALL: Self = Permission(PermissionRepr::InteractionSet(ALL_INTERACTION_BITSTRING));

    /// The single `c`reate interaction, as a v2 letter bag.
    pub const CREATE: Self = Permission(PermissionRepr::InteractionSet(CREATE_INTERACTION_BIT));
    /// The single `r`ead interaction, as a v2 letter bag.
    pub const READ: Self = Permission(PermissionRepr::InteractionSet(READ_INTERACTION_BIT));
    /// The single `u`pdate interaction, as a v2 letter bag.
    pub const UPDATE: Self = Permission(PermissionRepr::InteractionSet(UPDATE_INTERACTION_BIT));
    /// The single `d`elete interaction, as a v2 letter bag.
    pub const DELETE: Self = Permission(PermissionRepr::InteractionSet(DELETE_INTERACTION_BIT));
    /// The single `s`earch interaction, as a v2 letter bag.
    pub const SEARCH: Self = Permission(PermissionRepr::InteractionSet(SEARCH_INTERACTION_BIT));
    /// The `r`ead **and** `s`earch interactions, as a v2 letter bag (`rs`) — the
    /// SMART read+search permission a caller needs to export a whole resource
    /// collection. Spelled as a constant so callers name it instead of parsing
    /// `"rs"`, and it stays in the letter grammar an owner's `cruds` can cover.
    pub const READ_SEARCH: Self = Permission(PermissionRepr::InteractionSet(
        READ_INTERACTION_BIT | SEARCH_INTERACTION_BIT,
    ));

    /// Normalize a permission segment. Accepts the SMART v2 letter bags (`rs`,
    /// `cruds`) and the SMART v1 words (`read`/`write`/`*`), preserving which
    /// form was given. Returns `None` for an empty or unrecognized segment (e.g.
    /// a bag with a stray non-interaction letter).
    pub(in crate::scope) fn parse_segment(perms: &str) -> Option<Self> {
        match perms {
            "read" => Some(Permission(PermissionRepr::Read)),
            "write" => Some(Permission(PermissionRepr::Write)),
            "*" => Some(Permission(PermissionRepr::Star)),
            _ => {
                let mut bits = 0u8;
                for ch in perms.chars() {
                    bits |= INTERACTIONS
                        .iter()
                        .find(|(_, c)| *c == ch)
                        .map(|(bit, _)| *bit)?;
                }
                (bits != 0).then_some(Permission(PermissionRepr::InteractionSet(bits)))
            }
        }
    }

    /// Normalize a SMART v2 letter-bag segment only — rejects the v1 words
    /// (`read`/`write`/`*`). Wildflower scopes use the letter grammar
    /// exclusively, mirroring scopes-core's `CrudsPermission.parse`.
    pub(in crate::scope) fn parse_letter_segment(perms: &str) -> Option<Self> {
        Self::parse_segment(perms).filter(|p| !p.is_word_form())
    }

    /// The interaction bit set this grants, regardless of v1/v2 form.
    pub(in crate::scope) fn bits(self) -> u8 {
        match self.0 {
            PermissionRepr::Read => READ_INTERACTION_BIT | SEARCH_INTERACTION_BIT,
            PermissionRepr::Write => {
                CREATE_INTERACTION_BIT | UPDATE_INTERACTION_BIT | DELETE_INTERACTION_BIT
            }
            PermissionRepr::Star => ALL_INTERACTION_BITSTRING,
            PermissionRepr::InteractionSet(bits) => bits,
        }
    }

    /// Whether this permission was written in the SMART v1 word grammar
    /// (`read`/`write`/`*`) rather than the v2 letter-bag grammar.
    fn is_word_form(self) -> bool {
        matches!(
            self.0,
            PermissionRepr::Read | PermissionRepr::Write | PermissionRepr::Star
        )
    }

    /// Does `self` grant every interaction in `other`, **within the same
    /// grammar**? v1 words compare only against v1 words (`*` ⊇ `read`/`write`),
    /// letter bags only against letter bags; a cross-grammar pair is never
    /// covered — mirroring scopes-core's no-cross-style-conversion invariant.
    pub(in crate::scope) fn contains(self, other: Permission) -> bool {
        self.is_word_form() == other.is_word_form() && other.bits() & !self.bits() == 0
    }

    /// This same permission as a canonical v2 letter bag (`read` → `rs`,
    /// `write` → `cud`, `*` → `cruds`). A value already in letter form is
    /// returned unchanged. Lets a v1 word grant be re-emitted in the letter
    /// grammar a v2-only validator can read.
    pub(in crate::scope) fn to_interaction_set_representation(self) -> Self {
        Permission(PermissionRepr::InteractionSet(self.bits()))
    }
}

impl fmt::Display for Permission {
    /// v1 words render verbatim; v2 letter bags render in canonical `c,r,u,d,s`
    /// order.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.0 {
            PermissionRepr::Read => f.write_str("read"),
            PermissionRepr::Write => f.write_str("write"),
            PermissionRepr::Star => f.write_str("*"),
            PermissionRepr::InteractionSet(bits) => {
                for (bit, ch) in INTERACTIONS {
                    if bits & bit != 0 {
                        write!(f, "{ch}")?;
                    }
                }
                Ok(())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_segment_words_and_letters_share_bits_but_differ_in_form() {
        // v1 `read` and v2 `rs` cover the same interactions...
        let read = Permission::parse_segment("read").unwrap();
        let rs = Permission::parse_segment("rs").unwrap();
        assert_eq!(read.bits(), rs.bits());
        // ...but are distinct values, so each round-trips to the form it was given.
        assert_ne!(read, rs);

        let write = Permission::parse_segment("write").unwrap();
        let cud = Permission::parse_segment("cud").unwrap();
        assert_eq!(write.bits(), cud.bits());
        assert_ne!(write, cud);

        let star = Permission::parse_segment("*").unwrap();
        assert_eq!(star.bits(), Permission::ALL.bits());
        assert_ne!(star, Permission::ALL);

        // `cruds` is the canonical v2 spelling of every interaction.
        assert_eq!(Permission::parse_segment("cruds"), Some(Permission::ALL));
    }

    #[test]
    fn parse_segment_rejects_empty_and_stray_letters() {
        assert_eq!(Permission::parse_segment(""), None);
        assert_eq!(Permission::parse_segment("rx"), None);
    }

    #[test]
    fn display_renders_words_verbatim_and_letters_canonically() {
        // v1 words round-trip unchanged.
        assert_eq!(
            Permission::parse_segment("read").unwrap().to_string(),
            "read"
        );
        assert_eq!(
            Permission::parse_segment("write").unwrap().to_string(),
            "write"
        );
        assert_eq!(Permission::parse_segment("*").unwrap().to_string(), "*");
        // letter bags sort into canonical c,r,u,d,s order.
        assert_eq!(Permission::parse_segment("sr").unwrap().to_string(), "rs");
        assert_eq!(Permission::ALL.to_string(), "cruds");
    }

    #[test]
    fn contains_is_a_superset_check_within_a_grammar() {
        let all = Permission::ALL;
        let rs = Permission::parse_segment("rs").unwrap();
        assert!(all.contains(rs));
        assert!(!rs.contains(all));
        // Within the word grammar, `*` is the superset of both words.
        let star = Permission::parse_segment("*").unwrap();
        let read = Permission::parse_segment("read").unwrap();
        let write = Permission::parse_segment("write").unwrap();
        assert!(star.contains(read));
        assert!(star.contains(write));
        assert!(read.contains(read));
        assert!(!read.contains(write));
        assert!(!read.contains(star));
    }

    #[test]
    fn contains_never_crosses_grammars() {
        // Same bits, different grammars: neither direction covers.
        let read = Permission::parse_segment("read").unwrap();
        let rs = Permission::parse_segment("rs").unwrap();
        assert!(!read.contains(rs));
        assert!(!rs.contains(read));
        // Even the full sets don't bridge: `*` vs `cruds`.
        let star = Permission::parse_segment("*").unwrap();
        assert!(!star.contains(Permission::ALL));
        assert!(!Permission::ALL.contains(star));
    }

    #[test]
    fn single_interaction_constants_render_as_their_letter_and_are_covered_by_all() {
        assert_eq!(Permission::CREATE.to_string(), "c");
        assert_eq!(Permission::READ.to_string(), "r");
        assert_eq!(Permission::UPDATE.to_string(), "u");
        assert_eq!(Permission::DELETE.to_string(), "d");
        assert_eq!(Permission::SEARCH.to_string(), "s");
        // Each is a v2 letter bag, so `cruds` (ALL) covers it, and it round-trips
        // through the same letter grammar the Wildflower scopes use.
        for one in [
            Permission::CREATE,
            Permission::READ,
            Permission::UPDATE,
            Permission::DELETE,
            Permission::SEARCH,
        ] {
            assert!(Permission::ALL.contains(one));
            assert_eq!(
                Permission::parse_letter_segment(&one.to_string()),
                Some(one)
            );
        }
    }

    #[test]
    fn parse_letter_segment_rejects_v1_words() {
        assert_eq!(Permission::parse_letter_segment("read"), None);
        assert_eq!(Permission::parse_letter_segment("write"), None);
        assert_eq!(Permission::parse_letter_segment("*"), None);
        assert_eq!(
            Permission::parse_letter_segment("cruds"),
            Some(Permission::ALL)
        );
    }
}
