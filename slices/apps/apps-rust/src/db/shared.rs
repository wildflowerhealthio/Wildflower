//! The one diesel column mapping shared across kinds: [`AppUrlColumn`], the
//! `TEXT ↔ `[`AppUrl`] binding both the cloud and system configuration rows plug in
//! (a validated URL stored as TEXT). The per-kind columns live in their kind files
//! ([`PortColumn`](super::self_hosted_apps) with self-hosted, [`AppKindColumn`](super::app_registration)
//! with the registration).
//!
//! [`AppUrlColumn`] rejects an out-of-domain stored value on read (an unparseable
//! URL) as a diesel deserialization error rather than a panic or a silent unsafe
//! value — so a tampered row surfaces as a typed read error at the handler seam. It
//! is a thin newtype the row struct plugs in with
//! `#[diesel(serialize_as = …, deserialize_as = …)]`, keeping the field its natural
//! domain type. Mirrors the shared
//! [`JsonText`](shared_structures_rust::json_text::JsonText) pattern the collector
//! slice uses.

use diesel::deserialize::{self, FromSql, FromSqlRow};
use diesel::expression::AsExpression;
use diesel::serialize::{self, IsNull, Output, ToSql};
use diesel::sql_types::Text;
use diesel::sqlite::{Sqlite, SqliteValue};

use crate::domain::AppUrl;

/// An [`AppUrl`] bound to / read from a TEXT column as its canonical string, shared
/// by the cloud and system configuration rows. A stored value that no longer parses
/// surfaces as a diesel deserialization error, never a panic or an unsafe redirect
/// target.
#[derive(Debug, AsExpression, FromSqlRow)]
#[diesel(sql_type = Text)]
pub(super) struct AppUrlColumn(AppUrl);

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
