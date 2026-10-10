//! `sql_row!` generates a table's row-mapping boilerplate — the
//! `TryFrom<&Row>`, the named-parameter array [`build_insert_sql`] consumes, and
//! the `ALL_COLS` list — from one field list so the three can't drift. Invoked
//! in a slice's `db/` layer, keeping the rusqlite-coupled impls off the pure
//! `domain/*` structs.
//!
//! [`build_insert_sql`]: crate::build_insert_sql

/// Generate `impl TryFrom<&Row>` plus a named-param builder (and, in the default
/// form, `const ALL_COLS`) for a table whose column names equal its field names.
///
/// ```ignore
/// sql_row!(Client { client_id, name });                          // builder make_named_sql_params + ALL_COLS
/// sql_row!(RefreshToken { token_hash }, token_named_sql_params);  // explicit builder, no ALL_COLS
/// ```
///
/// Use the explicit-builder form for a module with a second table (one
/// `make_named_sql_params`/`ALL_COLS` would collide). Not for columns whose name
/// differs from the field, db-only wrappers, or JOIN-aliased `TryFrom`s — those
/// stay hand-written. Recursive arms self-qualify with `$crate::sql_row!`, so it
/// resolves however it's imported.
#[macro_export]
macro_rules! sql_row {
    // Default builder name; also emits the `ALL_COLS` SELECT/RETURNING column
    // list from the same field list.
    ($struct:path { $($field:ident),+ $(,)? }) => {
        $crate::sql_row!($struct { $($field),+ }, make_named_sql_params);
        const ALL_COLS: &str = $crate::sql_row!(@cols $($field)+);
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
        ) -> [(&str, &dyn ::rusqlite::ToSql); { $crate::sql_row!(@count $($field)+) }] {
            [ $( (concat!(":", stringify!($field)), &value.$field) ),+ ]
        }
    };
    // Count the fields into a const `usize` for the array length. The single-
    // ident base case avoids a trailing `+ 0usize` (which `clippy::identity_op`
    // would reject under `-D warnings`).
    (@count $field:ident) => { 1usize };
    (@count $field:ident $($rest:ident)+) => { 1usize + $crate::sql_row!(@count $($rest)+) };
    // Comma-join the field names into the `SELECT`/`RETURNING` column list at
    // compile time: `concat!("a", ", ", "b", ", ", "c")`. Splitting the first
    // field from the rest keeps the separator *between* fields (no trailing
    // ", ").
    (@cols $first:ident $($rest:ident)*) => {
        concat!(stringify!($first) $(, ", ", stringify!($rest))*)
    };
}
