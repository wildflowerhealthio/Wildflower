//! The `/requests` routes, one module per operation (`list`, `callers`); the
//! shared wire shapes live in [`wire_representations`].

pub(crate) mod callers;
pub(crate) mod list;
mod wire_representations;
