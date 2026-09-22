//! The router state is defined at the crate root ([`crate::live_bindings`]) so the
//! scope-gated capabilities in `domain/` can be built from it without `domain/`
//! depending on `crate::http`. This module re-exports it so the
//! `crate::http::state::GatekeeperState` call sites keep their path.

pub use crate::live_bindings::GatekeeperState;
