//! Diesel `SQLite` column mappings for the apps fields whose Rust type isn't a
//! plain diesel primitive: the [`AppKind`] discriminator (a kebab enum stored as
//! TEXT), the cloud / system [`AppUrl`] (a validated URL stored as TEXT), and the
//! self-hosted `port` (a `u16` stored as `INTEGER`). Each is a thin newtype the
//! row struct plugs in with `#[diesel(serialize_as = …, deserialize_as = …)]`,
//! keeping the struct field its natural domain type. Mirrors the shared
//! [`JsonText`](shared_structures_rust::json_text::JsonText) pattern the collector
//! slice uses.
//!
//! Each rejects an out-of-domain stored value on read (an unknown `kind`, an
//! unparseable URL, a port outside `1..=65535`) as a diesel deserialization error
//! rather than a panic or a silent unsafe value — so a tampered row surfaces as a
//! typed read error at the handler seam. Unlike the former table-per-struct view
//! decode (which read scalars by hand), the CTI reads go through these `FromSql`
//! impls via `Queryable`/`Selectable`.

use diesel::deserialize::{self, FromSql, FromSqlRow};
use diesel::expression::AsExpression;
use diesel::serialize::{self, IsNull, Output, ToSql};
use diesel::sql_types::{Integer, Text};
use diesel::sqlite::{Sqlite, SqliteValue};

use crate::domain::{AppKind, AppUrl};

/// An [`AppKind`] bound to / read from a TEXT column as its kebab string. A stored
/// value that isn't a known kind surfaces as a diesel deserialization error, never
/// a panic — matching the table's `CHECK (kind IN (…))` on the write side.
#[derive(Debug, AsExpression, FromSqlRow)]
#[diesel(sql_type = Text)]
pub struct AppKindColumn(AppKind);

impl From<AppKind> for AppKindColumn {
    fn from(kind: AppKind) -> Self {
        Self(kind)
    }
}

impl From<AppKindColumn> for AppKind {
    fn from(column: AppKindColumn) -> Self {
        column.0
    }
}

impl FromSql<Text, Sqlite> for AppKindColumn {
    fn from_sql(value: SqliteValue<'_, '_, '_>) -> deserialize::Result<Self> {
        let text = <String as FromSql<Text, Sqlite>>::from_sql(value)?;
        Ok(Self(text.parse::<AppKind>()?))
    }
}

impl ToSql<Text, Sqlite> for AppKindColumn {
    fn to_sql<'b>(&'b self, out: &mut Output<'b, '_, Sqlite>) -> serialize::Result {
        out.set_value(self.0.as_str());
        Ok(IsNull::No)
    }
}

/// An [`AppUrl`] bound to / read from a TEXT column as its canonical string. A
/// stored value that no longer parses surfaces as a diesel deserialization
/// error, never a panic or an unsafe redirect target.
#[derive(Debug, AsExpression, FromSqlRow)]
#[diesel(sql_type = Text)]
pub struct AppUrlColumn(AppUrl);

impl From<AppUrl> for AppUrlColumn {
    fn from(url: AppUrl) -> Self {
        Self(url)
    }
}

impl From<AppUrlColumn> for AppUrl {
    fn from(column: AppUrlColumn) -> Self {
        column.0
    }
}

impl FromSql<Text, Sqlite> for AppUrlColumn {
    fn from_sql(value: SqliteValue<'_, '_, '_>) -> deserialize::Result<Self> {
        let text = <String as FromSql<Text, Sqlite>>::from_sql(value)?;
        Ok(Self(text.parse::<AppUrl>()?))
    }
}

impl ToSql<Text, Sqlite> for AppUrlColumn {
    fn to_sql<'b>(&'b self, out: &mut Output<'b, '_, Sqlite>) -> serialize::Result {
        out.set_value(self.0.to_string());
        Ok(IsNull::No)
    }
}

/// A `u16` port bound to / read from an `INTEGER` column. `SQLite` integers are
/// `i64`; diesel reads them as `i32`, so the read narrows to `u16` and rejects an
/// out-of-range stored value (the table's `CHECK (port BETWEEN 1 AND 65535)`
/// keeps that unreachable for rows this crate writes).
#[derive(Debug, AsExpression, FromSqlRow)]
#[diesel(sql_type = Integer)]
pub struct PortColumn(u16);

impl From<u16> for PortColumn {
    fn from(port: u16) -> Self {
        Self(port)
    }
}

impl From<PortColumn> for u16 {
    fn from(column: PortColumn) -> Self {
        column.0
    }
}

impl FromSql<Integer, Sqlite> for PortColumn {
    fn from_sql(value: SqliteValue<'_, '_, '_>) -> deserialize::Result<Self> {
        let raw = <i32 as FromSql<Integer, Sqlite>>::from_sql(value)?;
        Ok(Self(u16::try_from(raw)?))
    }
}

impl ToSql<Integer, Sqlite> for PortColumn {
    fn to_sql<'b>(&'b self, out: &mut Output<'b, '_, Sqlite>) -> serialize::Result {
        out.set_value(i32::from(self.0));
        Ok(IsNull::No)
    }
}
