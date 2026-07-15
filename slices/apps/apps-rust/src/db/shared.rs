//! The [`text_column!`] macro that generates this slice's parse-backed TEXT-column
//! newtypes, plus [`AppUrlColumn`] — the one such column shared across kinds (the
//! `TEXT ↔ `[`AppUrl`] binding both the cloud and system configuration rows plug
//! in). The per-kind text column [`AppKindColumn`](super::app_registration) is built
//! from the same macro in the registration file; [`PortColumn`](super::self_hosted_apps)
//! is `INTEGER`-backed (a `u16 ⇄ i32` narrowing, not a text parse) so it stays
//! hand-written there.
//!
//! Each generated newtype rejects an out-of-domain stored value on read (an
//! unparseable string) as a diesel deserialization error rather than a panic or a
//! silent unsafe value — so a tampered row surfaces as a typed read error at the
//! handler seam. A row struct plugs one in on a plain field with
//! `#[diesel(serialize_as = …, deserialize_as = …)]`, keeping the field its natural
//! domain type. Mirrors both the shared
//! [`JsonText`](shared_structures_rust::json_text::JsonText) pattern the collector
//! slice uses and gatekeeper's `text_enum_column!` / `json_text_column!` macros.

use crate::domain::AppUrl;

/// Define a newtype that binds/reads its inner domain type through a TEXT column via
/// the inner type's [`Display`](std::fmt::Display)/[`FromStr`](std::str::FromStr): the
/// `serialize` expression maps the inner value to its stored string, and reads
/// `parse` it back. A stored value that no longer parses surfaces as a diesel
/// deserialization error, never a panic. All diesel paths are spelled absolutely so a
/// caller only needs the inner type in scope (and `FromStr` for it).
macro_rules! text_column {
    (
        $(#[$doc:meta])*
        $vis:vis $name:ident($inner:ty),
        serialize: |$value:ident| $to_text:expr $(,)?
    ) => {
        $(#[$doc])*
        #[derive(
            Debug,
            ::diesel::expression::AsExpression,
            ::diesel::deserialize::FromSqlRow,
        )]
        #[diesel(sql_type = ::diesel::sql_types::Text)]
        $vis struct $name($inner);

        impl ::core::convert::From<$inner> for $name {
            fn from(value: $inner) -> Self {
                Self(value)
            }
        }

        impl ::core::convert::From<$name> for $inner {
            fn from(column: $name) -> Self {
                column.0
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
                Ok(Self(text.parse::<$inner>()?))
            }
        }

        impl ::diesel::serialize::ToSql<::diesel::sql_types::Text, ::diesel::sqlite::Sqlite>
            for $name
        {
            fn to_sql<'b>(
                &'b self,
                out: &mut ::diesel::serialize::Output<'b, '_, ::diesel::sqlite::Sqlite>,
            ) -> ::diesel::serialize::Result {
                let $value = &self.0;
                out.set_value($to_text);
                Ok(::diesel::serialize::IsNull::No)
            }
        }
    };
}
pub(super) use text_column;

text_column!(
    /// An [`AppUrl`] bound to / read from a TEXT column as its canonical string, shared
    /// by the cloud and system configuration rows. A stored value that no longer parses
    /// surfaces as a diesel deserialization error, never a panic or an unsafe redirect
    /// target.
    pub(super) AppUrlColumn(AppUrl),
    serialize: |url| url.to_string(),
);
