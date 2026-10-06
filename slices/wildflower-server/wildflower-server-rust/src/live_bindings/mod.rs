//! The composition layer: [`set_up`] binds every server slice, the
//! [`crate::adapters`] that join them and the [`crate::http`] layers into one
//! served router, and [`hfs_base_url`] points HFS's base URL at the server's
//! public host.

mod hfs_base_url;
mod wildflower_server;

pub use wildflower_server::{set_up, WildflowerServer};
