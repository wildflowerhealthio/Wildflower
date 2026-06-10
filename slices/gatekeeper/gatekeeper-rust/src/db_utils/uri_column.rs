use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ToSqlOutput, ValueRef};
use rusqlite::ToSql;
use serde::{Deserialize, Serialize};
use std::ops::Deref;
use url::Url;

/// Newtype that stores a parsed `Url` in a TEXT SQLite column. Construction
/// goes through `Url::parse`, so anything held by the type has already
/// passed wire-format validation — downstream code can trust the shape
/// without re-parsing.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct UriColumn(pub Url);

impl From<Url> for UriColumn {
    fn from(value: Url) -> Self {
        UriColumn(value)
    }
}

impl Deref for UriColumn {
    type Target = Url;
    fn deref(&self) -> &Url {
        &self.0
    }
}

impl ToSql for UriColumn {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(ToSqlOutput::Borrowed(ValueRef::Text(
            self.0.as_str().as_bytes(),
        )))
    }
}

impl FromSql for UriColumn {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        let s = value.as_str()?;
        Url::parse(s)
            .map(UriColumn)
            .map_err(|e| FromSqlError::Other(Box::new(e)))
    }
}
