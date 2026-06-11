use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ToSqlOutput, Value, ValueRef};
use rusqlite::ToSql;
use serde::{Deserialize, Serialize};
use std::ops::{Deref, DerefMut};

/// Newtype that stores a `T` as a JSON string in SQLite. `Deref<Target =
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
