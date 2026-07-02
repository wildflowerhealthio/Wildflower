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
/// Coverage is always compared by the underlying interaction bit set, but the
/// SMART v1 *word* forms (`read`/`write`/`*`) are preserved so they round-trip:
/// per the SMART App Launch v1↔v2 back-compat rule, a grant requested as `read`
/// is returned as `read` (not its `rs` letter equivalent). v2 letter bags render
/// in canonical `c,r,u,d,s` order regardless of input order.
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

    /// Does `self` grant every interaction in `other`? Compared by interaction
    /// bits, so a v1 `read` covers a v2 `rs` and vice versa.
    pub(in crate::scope) fn contains(self, other: Permission) -> bool {
        other.bits() & !self.bits() == 0
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
    fn contains_is_a_superset_check() {
        let all = Permission::ALL;
        let rs = Permission::parse_segment("rs").unwrap();
        assert!(all.contains(rs));
        assert!(!rs.contains(all));
        // v1/v2 cross-form coverage works on bits: `read` and `rs` are mutual.
        let read = Permission::parse_segment("read").unwrap();
        assert!(read.contains(rs));
        assert!(rs.contains(read));
    }
}
