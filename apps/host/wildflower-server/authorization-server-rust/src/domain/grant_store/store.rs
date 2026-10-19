use super::GrantTx;
use crate::domain::authorization_server_error::AuthorizationServerError;

/// The transaction seam: the two scopes a capability runs its store work in.
/// Each capability method opens exactly one, at its top, and everything
/// beneath it (the flow, the authority proofs, the writers) takes the
/// [`GrantTx`] the scope hands out, never the store.
///
/// A scope's closure may fail with any error a flow defines, as long as an
/// [`AuthorizationServerError`] converts into it; an `Err` rolls a
/// [`write`](Self::write) scope back. A refusal that must keep what the scope
/// wrote (a spent code, a stamped poll) is an `Ok` outcome, not an `Err`.
pub trait GrantStore {
    /// The connection-scoped handle a scope hands its closure: for the
    /// `SQLite` adapter a checked-out diesel connection, for the fake the
    /// in-memory maps.
    type Tx<'a>: GrantTx
    where
        Self: 'a;

    /// Run `f` on one connection in autocommit, for an operation that only
    /// reads: no lock is held between its statements.
    ///
    /// # Errors
    ///
    /// Whatever `f` returns, plus [`AuthorizationServerError::Infrastructure`]
    /// if a connection can't be acquired.
    fn read<T, E: From<AuthorizationServerError>>(
        &self,
        f: impl FnOnce(&mut Self::Tx<'_>) -> Result<T, E>,
    ) -> Result<T, E>;

    /// Run `f` inside one `BEGIN IMMEDIATE` transaction, for an operation
    /// that writes: the write lock is taken before the first read, so a read
    /// that decides a write sees the row the write lands on. Committed when
    /// `f` returns `Ok`, rolled back when it returns `Err`.
    ///
    /// # Errors
    ///
    /// Whatever `f` returns, plus [`AuthorizationServerError::Infrastructure`]
    /// if the connection, `BEGIN IMMEDIATE` or `COMMIT` fails.
    fn write<T, E: From<AuthorizationServerError>>(
        &self,
        f: impl FnOnce(&mut Self::Tx<'_>) -> Result<T, E>,
    ) -> Result<T, E>;
}
