//! Core types for the collector slice's host side — no diesel-query or axum
//! coupling in the logic: the [`Remote`] row/wire shape and the
//! [`config_tag`]/[`required_config_tag`] discriminant readers, [`RemoteError`]
//! (the semantic failure vocabulary the HTTP layer renders), the [`RemotesStore`]
//! persistence port, and the [`actions`] the HTTP routes call against it.

pub(crate) mod actions;
mod remote;
mod remote_error;
mod remotes_store;

pub use remote::{config_tag, required_config_tag, Remote};
pub use remote_error::RemoteError;
pub use remotes_store::RemotesStore;
