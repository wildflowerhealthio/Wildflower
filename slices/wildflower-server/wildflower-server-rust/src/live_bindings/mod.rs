//! The composition layer: [`set_up`] binds every server slice, the
//! [`crate::adapters`] that join them and the [`crate::http`] layers into one
//! router served on the local and the [`tunnel_listener`], [`make_service`]
//! marks each connection with the listener it arrived on, and
//! [`hfs_base_url`] keeps HFS's base URL following the tunnel's public host.

mod hfs_base_url;
mod make_service;
mod tunnel_listener;
mod wildflower_server;

pub use wildflower_server::{set_up, WildflowerServer};
