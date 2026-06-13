//! A `macro_rules!` that generates the two verbose, drift-prone halves of a
//! table's row mapping from a single field list: the `impl TryFrom<&Row>` that
//! reads a domain struct out of a row, and the named-parameter array that
//! [`build_insert_sql`](super::sql_builder::build_insert_sql) turns into the
//! matching `INSERT`. Hand-writing both per table is how `db/*` drifted before
//! (a `TryFrom` that reads a column the params array doesn't write compiles
//! fine and mismaps at runtime); generating both from one list makes that
//! class of bug unrepresentable.
//!
//! The macro lives in `db_utils` (not on the `domain/*` structs) so the
//! `rusqlite`-coupled `TryFrom` impls stay in the `db/` layer — it is
//! *invoked* in `db/`, preserving the domain/db separation a `#[derive]` on the
//! pure structs would break.

/// Generate `impl TryFrom<&Row> for $struct` and a private parameter-array
/// builder for a table whose every column name equals its field name and whose
/// field types each carry their own `FromSql`/`ToSql` (directly, or via the
/// `JsonColumn`/`UriColumn` wrapper *fields*).
///
/// Two forms:
///
/// ```ignore
/// sql_row!(Client { client_id, name, kind, /* … */ });           // builder: make_named_sql_params
/// sql_row!(RefreshToken { token_hash, /* … */ }, token_named_sql_params);  // named builder
/// ```
///
/// The default form names the builder `make_named_sql_params`, the
/// one-table-per-module convention. The named form takes an explicit builder
/// name, for the one module (`refresh_tokens`) that also hand-maps a second
/// table and so can't reuse the default name.
///
/// Not for tables whose column name differs from its field name or that wrap a
/// field only at the db boundary (`signing_keys`' `values`/`values_json`), nor
/// for a `TryFrom` keyed on JOIN-aliased columns (`RefreshTokenFamily`) — those
/// stay hand-written.
macro_rules! sql_row {
    // Default builder name.
    ($struct:path { $($field:ident),+ $(,)? }) => {
        sql_row!($struct { $($field),+ }, make_named_sql_params);
    };
    // Explicit builder name.
    ($struct:path { $($field:ident),+ $(,)? }, $params_fn:ident) => {
        impl TryFrom<&::rusqlite::Row<'_>> for $struct {
            type Error = ::rusqlite::Error;
            fn try_from(row: &::rusqlite::Row<'_>) -> ::rusqlite::Result<Self> {
                Ok(Self { $( $field: row.get(stringify!($field))? ),+ })
            }
        }

        fn $params_fn(
            value: &$struct,
        ) -> [(&str, &dyn ::rusqlite::ToSql); { sql_row!(@count $($field)+) }] {
            [ $( (concat!(":", stringify!($field)), &value.$field) ),+ ]
        }
    };
    // Count the fields into a const `usize` for the array length. The single-
    // ident base case avoids a trailing `+ 0usize` (which `clippy::identity_op`
    // would reject under `-D warnings`).
    (@count $field:ident) => { 1usize };
    (@count $field:ident $($rest:ident)+) => { 1usize + sql_row!(@count $($rest)+) };
}

pub(crate) use sql_row;
