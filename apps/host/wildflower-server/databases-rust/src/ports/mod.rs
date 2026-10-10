//! Dependency-inversion **ports** the databases domain calls out through — the
//! seam between the pure, scope-gated [`capabilities`](crate::domain::capabilities)
//! and the real filesystem/SQLite side-effects. Keeping the traits here (rather
//! than in `domain/`) lets the domain depend on behaviour without owning the
//! interface's placement, and the concrete implementations live in
//! [`adapters`](crate::adapters). Mirrors `apps-rust` / `gatekeeper-rust`'s
//! `ports/`.
//!
//!  - [`DatabaseFiles`] — the filesystem/SQLite operations the capabilities need,
//!    abstracted so they depend on `std::fs` / `rusqlite` / a data directory only
//!    through this trait. Production impl:
//!    [`FilesystemDatabaseFiles`](crate::adapters::FilesystemDatabaseFiles); tests
//!    supply an in-memory fake.

mod database_files;

pub(crate) use database_files::DatabaseFiles;
