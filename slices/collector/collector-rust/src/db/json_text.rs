//! [`JsonText`] — the SQLite mapping for a `serde_json::Value` field stored in
//! a JSON TEXT column. Diesel 2.2's `serde_json` feature only wires
//! `serde_json::Value` to the `Json` sql type on the Postgres and MySQL
//! backends (SQLite `Json` support landed in diesel 2.3, which the workspace
//! deliberately stays off — see the root `Cargo.toml`), so this thin
//! `sql_type = Text` newtype carries the value through diesel instead.
//! [`crate::domain::Remote`] plugs it in with
//! `#[diesel(serialize_as = JsonText, deserialize_as = JsonText)]`, keeping the
//! field itself a plain `serde_json::Value`.

use diesel::deserialize::{self, FromSql, FromSqlRow};
use diesel::expression::AsExpression;
use diesel::serialize::{self, IsNull, Output, ToSql};
use diesel::sql_types::Text;
use diesel::sqlite::{Sqlite, SqliteValue};

/// A `serde_json::Value` bound to / read from a TEXT column as compact JSON.
///
/// Writes serialize with `serde_json::Value`'s `Display` (compact canonical
/// JSON — the same TEXT already stored, and a plain string bind the STRICT
/// table's TEXT column accepts). Reads parse the stored TEXT; corrupt JSON
/// surfaces as a diesel deserialization error, never a panic.
// `pub`, not `pub(crate)`: the type appears in the public `Queryable` /
// `Insertable` impls the derives on [`crate::domain::Remote`] generate (its
// `config` field maps through this type), so it must be at least as visible.
#[derive(Debug, AsExpression, FromSqlRow)]
#[diesel(sql_type = Text)]
pub struct JsonText(serde_json::Value);

impl From<serde_json::Value> for JsonText {
    fn from(value: serde_json::Value) -> Self {
        Self(value)
    }
}

impl From<JsonText> for serde_json::Value {
    fn from(json: JsonText) -> Self {
        json.0
    }
}

impl FromSql<Text, Sqlite> for JsonText {
    fn from_sql(value: SqliteValue<'_, '_, '_>) -> deserialize::Result<Self> {
        let text = <String as FromSql<Text, Sqlite>>::from_sql(value)?;
        Ok(Self(serde_json::from_str(&text)?))
    }
}

impl ToSql<Text, Sqlite> for JsonText {
    fn to_sql<'b>(&'b self, out: &mut Output<'b, '_, Sqlite>) -> serialize::Result {
        out.set_value(self.0.to_string());
        Ok(IsNull::No)
    }
}
