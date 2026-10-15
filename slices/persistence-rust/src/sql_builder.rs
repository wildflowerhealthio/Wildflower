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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_columns_and_their_named_placeholders_in_order() {
        let client_id = "abc".to_string();
        let name = "Lifting".to_string();
        let params: [(&str, &dyn ToSql); 2] = [(":client_id", &client_id), (":name", &name)];
        assert_eq!(
            build_insert_sql("clients", &params),
            "INSERT INTO clients (client_id, name) VALUES (:client_id, :name)",
        );
    }

    #[test]
    fn single_column_has_no_separator() {
        let id = 1_i64;
        let params: [(&str, &dyn ToSql); 1] = [(":id", &id)];
        assert_eq!(
            build_insert_sql("t", &params),
            "INSERT INTO t (id) VALUES (:id)"
        );
    }
}
