//! The rusqlite `ToSql`/`FromSql` glue for the two column newtypes
//! ([`Provenance`] and [`AppUrl`]). Both round-trip through their canonical
//! string form — the one the schema constraints match and `str::parse`
//! accepts — and an unparseable stored value (a tampered row) surfaces as a
//! typed read error rather than a panic or a silent unsafe value.

use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ToSqlOutput, Value, ValueRef};
use rusqlite::ToSql;

use crate::domain::{AppUrl, Provenance};

impl ToSql for Provenance {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        // The kebab discriminant the `CHECK (provenance IN (...))` constraint
        // matches; the one `str::parse` round-trips.
        Ok(ToSqlOutput::Owned(Value::Text(self.as_str().to_owned())))
    }
}

impl FromSql for Provenance {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        let s = value.as_str()?;
        // An unknown discriminant (a tampered row) surfaces as a typed read
        // error rather than a panic.
        s.parse::<Provenance>()
            .map_err(|e| FromSqlError::Other(Box::new(e)))
    }
}

impl ToSql for AppUrl {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        // The canonical string (see `AppUrl`'s `Display`) — the only form the
        // `url` column ever holds, and the one `str::parse` round-trips.
        Ok(ToSqlOutput::Owned(Value::Text(self.to_string())))
    }
}

impl FromSql for AppUrl {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        let s = value.as_str()?;
        // A stored URL that no longer parses (e.g. an externally tampered row)
        // surfaces as a typed read error rather than a silent unsafe redirect.
        s.parse::<AppUrl>()
            .map_err(|e| FromSqlError::Other(Box::new(e)))
    }
}
