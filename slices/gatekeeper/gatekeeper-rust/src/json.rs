use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ToSqlOutput, Value, ValueRef};
use rusqlite::ToSql;
use serde::{Deserialize, Serialize};
use std::ops::{Deref, DerefMut};

/// Newtype that stores a `T` as a JSON string in SQLite. `Deref<Target =
/// T>` keeps callers ergonomic: `req.requested_scopes.iter()` still
/// works without unwrapping the inner value.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Json<T>(pub T);

impl<T> From<T> for Json<T> {
    fn from(value: T) -> Self {
        Json(value)
    }
}

impl<T> Deref for Json<T> {
    type Target = T;
    fn deref(&self) -> &T {
        &self.0
    }
}

impl<T> DerefMut for Json<T> {
    fn deref_mut(&mut self) -> &mut T {
        &mut self.0
    }
}

impl<T: Serialize> ToSql for Json<T> {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        let s = serde_json::to_string(&self.0)
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
        Ok(ToSqlOutput::Owned(Value::Text(s)))
    }
}

impl<T: serde::de::DeserializeOwned> FromSql for Json<T> {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        let s = value.as_str()?;
        serde_json::from_str(s)
            .map(Json)
            .map_err(|e| FromSqlError::Other(Box::new(e)))
    }
}
