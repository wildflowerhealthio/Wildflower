//! The composition layer: [`set_up`] binds every server slice, the
//! [`crate::adapters`] that join them and the [`crate::http`] layers into one
//! served router.

mod wildflower_server;

pub use wildflower_server::{set_up, WildflowerServer};
