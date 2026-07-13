//! [`App`] — the combined form of an app, composed in the HTTP layer: the shared
//! [`AppRegistration`] paired with its [`AppConfiguration`]. The store and domain
//! speak the two halves separately; this brings them back together for the seams
//! that need a whole app of runtime-resolved kind — the launch dispatch (which
//! target a launch renders, see [`resolve_launch`](crate::http::routes::apps::launch))
//! and `DELETE`'s removability check. Built from an
//! [`actions::get_app`](crate::domain::actions) read.

use crate::domain::{AppConfiguration, AppRegistration};

/// A whole app at the HTTP seam: the shared registration + its per-kind
/// configuration (the [`AppConfiguration`] union, since the kind is resolved at
/// read time).
pub(crate) struct App {
    pub(crate) registration: AppRegistration,
    pub(crate) configuration: AppConfiguration,
}

impl App {
    /// The display name — used to title the on-device launch popup.
    pub(crate) fn name(&self) -> &str {
        &self.registration.name
    }
}
