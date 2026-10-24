//! [`ClaimCodeTarget`] — what a claim code redeems for.

/// The tunnel a claim code redeems for: one already stored, named when the
/// code was issued, or one the redeemer creates under the email and name
/// they choose.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClaimCodeTarget {
    /// The stored tunnel named `tunnel_name`, whose name and token the code
    /// redeems for. A tunnel has at most one such code.
    Preset { tunnel_name: String },
    /// A new tunnel, created when the code is redeemed with an email and,
    /// optionally, a name.
    Open,
}
