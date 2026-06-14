use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ToSqlOutput, Value, ValueRef};
use rusqlite::ToSql;
use serde::{Deserialize, Serialize};
use std::ops::{Deref, DerefMut};

/// Newtype that stores a `T` as a JSON string in `SQLite`. `Deref<Target =
/// T>` keeps callers ergonomic: `req.requested_scopes.iter()` still
/// works without unwrapping the inner value.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct JsonColumn<T>(pub T);

impl<T> From<T> for JsonColumn<T> {
    fn from(value: T) -> Self {
        JsonColumn(value)
    }
}

impl<T> JsonColumn<T> {
    /// Consume the wrapper and return the inner `T`. The orphan rule blocks a
    /// `From<JsonColumn<T>> for T` impl (foreign `T`), so this is the unwrap.
    pub fn into_inner(self) -> T {
        self.0
    }
}

impl<T> Deref for JsonColumn<T> {
    type Target = T;
    fn deref(&self) -> &T {
        &self.0
    }
}

impl<T> DerefMut for JsonColumn<T> {
    fn deref_mut(&mut self) -> &mut T {
        &mut self.0
    }
}

impl<T: Serialize> ToSql for JsonColumn<T> {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        let s = serde_json::to_string(&self.0)
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
        Ok(ToSqlOutput::Owned(Value::Text(s)))
    }
}

impl<T: serde::de::DeserializeOwned> FromSql for JsonColumn<T> {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        let s = value.as_str()?;
        serde_json::from_str(s)
            .map(JsonColumn)
            .map_err(|e| FromSqlError::Other(Box::new(e)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    /// Round-trip a `JsonColumn<Vec<String>>` through a real `SQLite` TEXT column
    /// and assert both the decoded value and the raw stored JSON. An empty
    /// `Vec` is the case the `pre_approved_scopes` `Option` -> `Vec` collapse
    /// relies on: it must store the bare array `[]` (matching the column's
    /// `NOT NULL DEFAULT '[]'`) and read back as empty, never as SQL NULL.
    fn round_trip(value: Vec<String>) -> (String, Vec<String>) {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute("CREATE TABLE t (scopes TEXT NOT NULL)", [])
            .unwrap();
        conn.execute("INSERT INTO t (scopes) VALUES (?1)", [JsonColumn(value)])
            .unwrap();
        conn.query_row("SELECT scopes FROM t", [], |row| {
            let raw: String = row.get(0)?;
            let decoded: JsonColumn<Vec<String>> = row.get(0)?;
            Ok((raw, decoded.into_inner()))
        })
        .unwrap()
    }

    #[test]
    fn empty_vec_stores_as_bare_array_and_reads_back_empty() {
        let (raw, decoded) = round_trip(Vec::new());
        assert_eq!(raw, "[]");
        assert_eq!(decoded, Vec::<String>::new());
    }

    #[test]
    fn populated_vec_round_trips() {
        let (raw, decoded) = round_trip(vec!["openid".to_string(), "profile".to_string()]);
        assert_eq!(raw, r#"["openid","profile"]"#);
        assert_eq!(decoded, vec!["openid".to_string(), "profile".to_string()]);
    }
}
