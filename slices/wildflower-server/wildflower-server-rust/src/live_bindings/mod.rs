//! The composition layer: [`set_up`] binds every server slice, the
//! [`crate::adapters`] that join them and the [`crate::http`] layers into the
//! routers the loopback and tunnel listeners serve.

mod wildflower_server;

pub use wildflower_server::{set_up, WildflowerServer};
