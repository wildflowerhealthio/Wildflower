//! Concrete implementations of the databases [`ports`](crate::ports) — the real
//! side-effecting adapters the host wires in. Currently just
//! [`FilesystemDatabaseFiles`](filesystem_database_files::FilesystemDatabaseFiles),
//! the `std::fs` / `rusqlite` implementation of the
//! [`DatabaseFiles`](crate::ports::DatabaseFiles) port over the host's data
//! directory. Mirrors `gatekeeper-rust`'s `adapters/`.

mod filesystem_database_files;

pub(crate) use filesystem_database_files::FilesystemDatabaseFiles;
