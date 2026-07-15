//! Core types for the databases slice's host side — currently just
//! [`DatabaseError`], the semantic failure vocabulary the HTTP layer renders.
//! The slice owns no store, so there is no row/wire domain type here; the wire
//! metadata shape lives in [`crate::metadata`].

mod database_error;

pub use database_error::DatabaseError;
