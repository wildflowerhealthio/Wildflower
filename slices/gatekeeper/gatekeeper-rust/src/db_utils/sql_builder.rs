use std::fmt::Write;

use rusqlite::ToSql;

/// Build an `INSERT INTO {table} (cols) VALUES (placeholders)` statement
/// from the same `[(":colName", &dyn ToSql); N]` array a row's
/// `make_named_sql_params` returns — keeps the column list and the named
/// placeholders from drifting.
pub(crate) fn build_insert_sql(table: &str, params: &[(&str, &dyn ToSql)]) -> String {
    let mut sql = String::with_capacity(64 + table.len() + params.len() * 32);
    write!(sql, "INSERT INTO {table} (").unwrap();
    for (i, (placeholder, _)) in params.iter().enumerate() {
        if i > 0 {
            sql.push_str(", ");
        }
        sql.push_str(placeholder.trim_start_matches(':'));
    }
    sql.push_str(") VALUES (");
    for (i, (placeholder, _)) in params.iter().enumerate() {
        if i > 0 {
            sql.push_str(", ");
        }
        sql.push_str(placeholder);
    }
    sql.push(')');
    sql
}
