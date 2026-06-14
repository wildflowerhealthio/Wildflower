use rusqlite::ToSql;

/// Build an `INSERT INTO {table} (cols) VALUES (placeholders)` statement
/// from the same `[(":colName", &dyn ToSql); N]` array a row's
/// `make_named_sql_params` returns — keeps the column list and the named
/// placeholders from drifting.
pub fn build_insert_sql(table: &str, params: &[(&str, &dyn ToSql)]) -> String {
    let mut sql = format!("INSERT INTO {table} (");
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
