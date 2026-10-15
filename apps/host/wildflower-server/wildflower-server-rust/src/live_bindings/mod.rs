//! The composition layer: [`set_up`] binds every server slice, the
//! [`crate::adapters`] that join them and the [`crate::http`] layers into the
//! router the tunnel listener serves, and starts the device
//! certificate the tunnel listener's TLS serves.

mod wildflower_server;

pub use wildflower_server::{set_up, WildflowerServer};
