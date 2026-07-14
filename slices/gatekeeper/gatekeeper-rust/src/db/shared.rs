//! Diesel column mappings shared across more than one persistence concern, plus
//! the two macros that generate every column mapping in this slice (`shared` and
//! per-concern alike). A column mapping used by exactly one concern lives in that
//! concern's `db/<concern>.rs` file (e.g. [`JsonUrls`](super::clients) with the
//! client); the ones here — [`JsonStrings`], [`UrlText`], and the [`GrantType`]
//! enum mapping — are the ones two or more concerns bind.
//!
//! A domain row type plugs a newtype in on a plain field with
//! `#[diesel(serialize_as = …, deserialize_as = …)]`, keeping the field itself the
//! domain type (`Vec<String>`, `Url`, …). Reads parse the stored TEXT, so a
//! corrupt/out-of-domain stored value surfaces as a diesel deserialization error,
//! never a panic. The newtypes are `pub` because they appear in the
//! `Queryable`/`Insertable` impls the pub domain row types derive.
//!
//! Both macros spell every diesel/serde path absolutely (`::diesel::…`,
//! `::serde_json::…`), so a `db/<concern>.rs` can invoke them after a bare
//! `use crate::db::shared::{json_text_column, text_enum_column};` — no diesel
//! trait imports at the call site.

use url::Url;

/// Define a newtype that binds/reads its inner value as compact JSON in a TEXT
/// column — one concrete type per inner shape (a generic would run into diesel's
/// derive limitations). Reads parse the stored TEXT; corrupt JSON surfaces as a
/// diesel deserialization error, never a panic.
macro_rules! json_text_column {
    ($(#[$doc:meta])* $name:ident, $inner:ty) => {
        $(#[$doc])*
        #[derive(
            Debug,
            ::diesel::expression::AsExpression,
            ::diesel::deserialize::FromSqlRow,
        )]
        #[diesel(sql_type = ::diesel::sql_types::Text)]
        pub struct $name(pub $inner);

        impl ::core::convert::From<$inner> for $name {
            fn from(value: $inner) -> Self {
                Self(value)
            }
        }

        impl ::core::convert::From<$name> for $inner {
            fn from(wrapper: $name) -> Self {
                wrapper.0
            }
        }

        impl ::diesel::deserialize::FromSql<::diesel::sql_types::Text, ::diesel::sqlite::Sqlite>
            for $name
        {
            fn from_sql(
                value: ::diesel::sqlite::SqliteValue<'_, '_, '_>,
            ) -> ::diesel::deserialize::Result<Self> {
                let text = <String as ::diesel::deserialize::FromSql<
                    ::diesel::sql_types::Text,
                    ::diesel::sqlite::Sqlite,
                >>::from_sql(value)?;
                Ok(Self(::serde_json::from_str(&text)?))
            }
        }

        impl ::diesel::serialize::ToSql<::diesel::sql_types::Text, ::diesel::sqlite::Sqlite>
            for $name
        {
            fn to_sql<'b>(
                &'b self,
                out: &mut ::diesel::serialize::Output<'b, '_, ::diesel::sqlite::Sqlite>,
            ) -> ::diesel::serialize::Result {
                out.set_value(::serde_json::to_string(&self.0)?);
                Ok(::diesel::serialize::IsNull::No)
            }
        }
    };
}
pub(crate) use json_text_column;

/// Map a stored-as-text domain enum straight through diesel using its strum wire
/// strings, so the enum can be a row-struct field (and a query bind) without a
/// wrapper. The enum itself carries the `AsExpression`/`FromSqlRow` derives (they
/// must sit on the definition, in `domain`); this macro adds only the
/// `FromSql`/`ToSql` bind/read impls.
macro_rules! text_enum_column {
    ($name:ty) => {
        impl ::diesel::deserialize::FromSql<::diesel::sql_types::Text, ::diesel::sqlite::Sqlite>
            for $name
        {
            fn from_sql(
                value: ::diesel::sqlite::SqliteValue<'_, '_, '_>,
            ) -> ::diesel::deserialize::Result<Self> {
                let text = <String as ::diesel::deserialize::FromSql<
                    ::diesel::sql_types::Text,
                    ::diesel::sqlite::Sqlite,
                >>::from_sql(value)?;
                Ok(text.parse::<$name>()?)
            }
        }

        impl ::diesel::serialize::ToSql<::diesel::sql_types::Text, ::diesel::sqlite::Sqlite>
            for $name
        {
            fn to_sql<'b>(
                &'b self,
                out: &mut ::diesel::serialize::Output<'b, '_, ::diesel::sqlite::Sqlite>,
            ) -> ::diesel::serialize::Result {
                out.set_value(self.as_ref().to_owned());
                Ok(::diesel::serialize::IsNull::No)
            }
        }
    };
}
pub(crate) use text_enum_column;

json_text_column!(
    /// A `Vec<String>` (scopes, mostly) as a JSON TEXT column — bound by
    /// authorization requests, grants, and refresh-token families.
    JsonStrings,
    Vec<String>
);

/// A [`Url`] bound to / read from a TEXT column as its canonical string — bound by
/// authorization requests, authorization codes, and the authorization-code grant.
/// Reads re-parse, so a corrupt stored URL surfaces as a diesel deserialization
/// error, never a panic.
#[derive(Debug, diesel::expression::AsExpression, diesel::deserialize::FromSqlRow)]
#[diesel(sql_type = diesel::sql_types::Text)]
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

impl diesel::deserialize::FromSql<diesel::sql_types::Text, diesel::sqlite::Sqlite> for UrlText {
    fn from_sql(
        value: diesel::sqlite::SqliteValue<'_, '_, '_>,
    ) -> diesel::deserialize::Result<Self> {
        let text = <String as diesel::deserialize::FromSql<
            diesel::sql_types::Text,
            diesel::sqlite::Sqlite,
        >>::from_sql(value)?;
        Ok(Self(Url::parse(&text)?))
    }
}

impl diesel::serialize::ToSql<diesel::sql_types::Text, diesel::sqlite::Sqlite> for UrlText {
    fn to_sql<'b>(
        &'b self,
        out: &mut diesel::serialize::Output<'b, '_, diesel::sqlite::Sqlite>,
    ) -> diesel::serialize::Result {
        out.set_value(self.0.as_str().to_owned());
        Ok(diesel::serialize::IsNull::No)
    }
}

// The `grant_type` discriminant is bound by both `authorization_requests` (the
// flow kind) and the cross-kind `grants` view, so its mapping is shared. The
// enum's `AsExpression`/`FromSqlRow` derives live on its definition in
// `domain::authorization_request`.
text_enum_column!(crate::domain::authorization_request::GrantType);
