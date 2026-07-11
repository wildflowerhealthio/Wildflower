//! Diesel column mappings for the gatekeeper's typed fields: JSON-in-TEXT
//! newtypes (the typed cousins of the shared, `serde_json::Value`-shaped
//! [`shared_structures_rust::json_text::JsonText`]), a `Url`-in-TEXT newtype,
//! and text mappings for the stored-as-text domain enums.
//!
//! A domain row type plugs a newtype in on a plain field with
//! `#[diesel(serialize_as = …, deserialize_as = …)]`, keeping the field itself
//! the domain type (`Vec<String>`, `Url`, …). The newtypes are `pub` because
//! they appear in the `Queryable`/`Insertable` impls the pub domain row types
//! derive, which must be at least as visible as the row type.

use diesel::deserialize::{self, FromSql, FromSqlRow};
use diesel::expression::AsExpression;
use diesel::serialize::{self, IsNull, Output, ToSql};
use diesel::sql_types::Text;
use diesel::sqlite::{Sqlite, SqliteValue};
use url::Url;

use crate::domain::authorization_request::{GrantType, RequestStatus};
use crate::domain::client::{AllowedGrantType, ClientKind};
use crate::domain::signing_key::SigningKeyValues;

/// Define a newtype that binds/reads its inner value as compact JSON in a
/// TEXT column — one concrete type per inner shape (a generic would run into
/// diesel's derive limitations). Reads parse the stored TEXT; corrupt JSON
/// surfaces as a diesel deserialization error, never a panic.
macro_rules! json_text_column {
    ($(#[$doc:meta])* $name:ident, $inner:ty) => {
        $(#[$doc])*
        #[derive(Debug, AsExpression, FromSqlRow)]
        #[diesel(sql_type = Text)]
        pub struct $name(pub $inner);

        impl From<$inner> for $name {
            fn from(value: $inner) -> Self {
                Self(value)
            }
        }

        impl From<$name> for $inner {
            fn from(wrapper: $name) -> Self {
                wrapper.0
            }
        }

        impl FromSql<Text, Sqlite> for $name {
            fn from_sql(value: SqliteValue<'_, '_, '_>) -> deserialize::Result<Self> {
                let text = <String as FromSql<Text, Sqlite>>::from_sql(value)?;
                Ok(Self(serde_json::from_str(&text)?))
            }
        }

        impl ToSql<Text, Sqlite> for $name {
            fn to_sql<'b>(&'b self, out: &mut Output<'b, '_, Sqlite>) -> serialize::Result {
                out.set_value(serde_json::to_string(&self.0)?);
                Ok(IsNull::No)
            }
        }
    };
}

json_text_column!(
    /// A `Vec<String>` (scopes, mostly) as a JSON TEXT column.
    JsonStrings,
    Vec<String>
);
json_text_column!(
    /// A client's `redirect_uris` allowlist as a JSON TEXT column.
    JsonUrls,
    Vec<Url>
);
json_text_column!(
    /// A client's `allowed_grant_types` as a JSON TEXT column (the wire
    /// `grant_type` strings, per [`AllowedGrantType`]'s serde renames).
    JsonAllowedGrantTypes,
    Vec<AllowedGrantType>
);
json_text_column!(
    /// A signing key's RSA components (`values_json` column) as JSON TEXT.
    JsonSigningKeyValues,
    SigningKeyValues
);

/// A [`Url`] bound to / read from a TEXT column as its canonical string.
/// Reads re-parse, so a corrupt stored URL surfaces as a diesel
/// deserialization error, never a panic.
#[derive(Debug, AsExpression, FromSqlRow)]
#[diesel(sql_type = Text)]
pub struct UrlText(pub Url);

impl From<Url> for UrlText {
    fn from(url: Url) -> Self {
        Self(url)
    }
}

impl From<UrlText> for Url {
    fn from(wrapper: UrlText) -> Self {
        wrapper.0
    }
}

impl FromSql<Text, Sqlite> for UrlText {
    fn from_sql(value: SqliteValue<'_, '_, '_>) -> deserialize::Result<Self> {
        let text = <String as FromSql<Text, Sqlite>>::from_sql(value)?;
        Ok(Self(Url::parse(&text)?))
    }
}

impl ToSql<Text, Sqlite> for UrlText {
    fn to_sql<'b>(&'b self, out: &mut Output<'b, '_, Sqlite>) -> serialize::Result {
        out.set_value(self.0.as_str().to_owned());
        Ok(IsNull::No)
    }
}

/// Map a stored-as-text domain enum straight through diesel using its strum
/// wire strings, so the enum can be a row-struct field (and a query bind)
/// without a wrapper. The enum itself carries the
/// `AsExpression`/`FromSqlRow` derives (they must sit on the definition).
macro_rules! text_enum_column {
    ($name:ty) => {
        impl FromSql<Text, Sqlite> for $name {
            fn from_sql(value: SqliteValue<'_, '_, '_>) -> deserialize::Result<Self> {
                let text = <String as FromSql<Text, Sqlite>>::from_sql(value)?;
                Ok(text.parse::<$name>()?)
            }
        }

        impl ToSql<Text, Sqlite> for $name {
            fn to_sql<'b>(&'b self, out: &mut Output<'b, '_, Sqlite>) -> serialize::Result {
                out.set_value(self.as_ref().to_owned());
                Ok(IsNull::No)
            }
        }
    };
}

text_enum_column!(GrantType);
text_enum_column!(RequestStatus);
text_enum_column!(ClientKind);
