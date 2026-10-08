//! The composition layer: [`set_up`] binds every server slice, the
//! [`crate::adapters`] that join them and the [`crate::http`] layers into the
//! routers the loopback and tunnel listeners serve, and starts the
//! [`device_certificate`] the tunnel listener's TLS serves.

pub(crate) mod device_certificate;
mod wildflower_server;

pub use device_certificate::lets_encrypt_directory_url;
pub use wildflower_server::{set_up, WildflowerServer};
