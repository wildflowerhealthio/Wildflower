//! The composition layer: the [`crate::ports`] seams implemented onto the
//! concrete runtime types. Each adapter lives here rather than beside its trait
//! so `ports/` stays a set of bare contracts the domain can name without
//! learning what implements them.

pub(crate) mod owner_approval;
pub(crate) mod revocation_store;
