//! A `macro_rules!` that generates the three verbose, drift-prone copies of a
//! table's column list from a single field list: the `impl TryFrom<&Row>` that
//! reads a domain struct out of a row, the named-parameter array that
//! [`build_insert_sql`](super::sql_builder::build_insert_sql) turns into the
//! matching `INSERT`, and the `ALL_COLS` `&str` the module's `SELECT` /
//! `RETURNING` statements interpolate. Hand-writing them per table is how `db/*`
//! drifted before (a `TryFrom` that reads a column the params array doesn't
//! write compiles fine and mismaps at runtime); generating them from one list
//! makes that class of bug unrepresentable.
//!
//! The macro lives in `db_utils` (not on the `domain/*` structs) so the
//! `rusqlite`-coupled `TryFrom` impls stay in the `db/` layer — it is
//! *invoked* in `db/`, preserving the domain/db separation a `#[derive]` on the
//! pure structs would break.

/// Generate `impl TryFrom<&Row> for $struct` and a private parameter-array
/// builder for a table whose every column name equals its field name and whose
/// field types each carry their own `FromSql`/`ToSql` (directly, or via the
/// `JsonColumn`/`UriColumn` wrapper *fields*). The default form additionally
/// emits `const ALL_COLS: &str` — the comma-joined column list the module's
/// `SELECT` / `RETURNING` statements interpolate.
///
/// Two forms:
///
/// ```ignore
/// sql_row!(Client { client_id, name, kind, /* … */ });           // make_named_sql_params + ALL_COLS
/// sql_row!(RefreshToken { token_hash, /* … */ }, token_named_sql_params);  // named builder, no ALL_COLS
/// ```
///
/// The default form names the builder `make_named_sql_params` and emits
/// `ALL_COLS` — the one-table-per-module convention. The named form takes an
/// explicit builder name and emits no `ALL_COLS`: a second table in the same
/// module would collide on the const name, and its only user (`refresh_tokens`)
/// selects JOIN-aliased columns a bare `ALL_COLS` couldn't express. It's for the
/// one module (`refresh_tokens`) that also hand-maps a second table and so can't
/// reuse the default name.
///
/// Not for tables whose column name differs from its field name or that wrap a
/// field only at the db boundary (`signing_keys`' `values`/`values_json`), nor
/// for a `TryFrom` keyed on JOIN-aliased columns (`RefreshTokenFamily`) — those
/// stay hand-written.
macro_rules! sql_row {
    // Default builder name; also emits the `ALL_COLS` SELECT/RETURNING column
    // list from the same field list.
    ($struct:path { $($field:ident),+ $(,)? }) => {
        sql_row!($struct { $($field),+ }, make_named_sql_params);
        const ALL_COLS: &str = sql_row!(@cols $($field)+);
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
    // Comma-join the field names into the `SELECT`/`RETURNING` column list at
    // compile time: `concat!("a", ", ", "b", ", ", "c")`. Splitting the first
    // field from the rest keeps the separator *between* fields (no trailing
    // ", ").
    (@cols $first:ident $($rest:ident)*) => {
        concat!(stringify!($first) $(, ", ", stringify!($rest))*)
    };
}

pub(crate) use sql_row;
