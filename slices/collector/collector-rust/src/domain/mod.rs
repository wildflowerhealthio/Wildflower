//! Core types for the collector slice's host side: the [`Remote`] row/wire
//! shape, the [`config_tag`]/[`required_config_tag`] discriminant readers, and
//! [`RemoteError`] — the semantic failure vocabulary the HTTP layer renders.

use diesel::prelude::{Insertable, Queryable, Selectable};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::db::json_text::JsonText;
use crate::db::schema::collector_remotes;

/// A stored remote — the wire shape the `/collector/remotes` endpoints serve
/// (the TS `RemoteSchema` in
/// `collector-core/src/http-api-definition/remotes.ts`) AND the
/// `collector_remotes` row: the diesel derives map this type straight to/from
/// the table, with [`JsonText`] converting `config` between `Value` and the
/// JSON TEXT column at the bind/read boundary. serde's camelCase rename
/// produces the wire's `addedAt`.
#[derive(
    Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema, Queryable, Selectable, Insertable,
)]
#[serde(rename_all = "camelCase")]
#[diesel(table_name = collector_remotes)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub struct Remote {
    pub id: String,
    pub name: String,
    /// Denormalized copy of `config._tag`, written alongside the config so
    /// clients filtering by collector kind don't need to crack the config JSON
    /// (mirrors the TS `RemoteSchema.tag` doc). Kept in sync by the write
    /// handlers — [`config_tag`] is the single reader they both denormalize
    /// through.
    pub tag: String,
    /// The full tagged `CollectorConfig` JSON, **opaque to Rust**: the
    /// per-collector config union is TS-owned (`collector-core`'s registry),
    /// so this crate stores and serves it verbatim rather than modeling it —
    /// adding a TS collector never requires a Rust change. The column keeps
    /// it as JSON TEXT; [`JsonText`] round-trips it through `serde_json`.
    /// `value_type = Value` keeps the OpenAPI schema an unconstrained `{}` (a
    /// wildcard to the TS spec-drift engine), matching that opacity.
    #[schema(value_type = Value)]
    #[diesel(serialize_as = JsonText, deserialize_as = JsonText)]
    pub config: serde_json::Value,
    /// ISO-8601 UTC with milliseconds (e.g. `2026-06-17T14:29:22.363Z`) —
    /// the encoding the TS `Schema.DateTimeUtc` round-trips.
    pub added_at: String,
}

/// The `_tag` discriminant of a `CollectorConfig` JSON value, or `None` when
/// the value isn't an object carrying a string `_tag`. The only field of the
/// otherwise-opaque config Rust reads — the write handlers denormalize it into
/// the `tag` column (and reject a config without one, since the wire `tag`
/// couldn't be produced).
#[must_use]
pub fn config_tag(config: &serde_json::Value) -> Option<&str> {
    config.get("_tag").and_then(serde_json::Value::as_str)
}

/// The `config._tag` discriminant as an owned `String`, or
/// [`RemoteError::InvalidConfig`] when it's absent — without it neither the
/// `tag` column nor the wire `tag` field can be produced. Shared by the write
/// operations (create + update). Unreachable through the typed TS client, which
/// validates the config union before sending.
///
/// # Errors
///
/// [`RemoteError::InvalidConfig`] when `config` carries no string `_tag`.
pub fn required_config_tag(config: &serde_json::Value) -> Result<String, RemoteError> {
    config_tag(config)
        .map(str::to_owned)
        .ok_or_else(|| RemoteError::InvalidConfig {
            message: "config._tag must be a string".to_owned(),
        })
}

/// The ways a remotes operation can fail — the domain's failure vocabulary. The
/// first three are **semantic**, client-facing outcomes that are part of the
/// wire contract; [`Backend`](RemoteError::Backend) is an opaque infrastructure
/// failure. The HTTP layer ([`crate::http::errors`]) renders each to a status
/// and wire body (or a logged opaque 500 for `Backend`); nothing here knows
/// about HTTP, and the store ([`crate::db`]) produces `Backend` without leaking
/// its db/`anyhow` types up to the routes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemoteError {
    /// No remote has this id (a read / update / delete addressed an unknown id).
    NotFound { id: String },
    /// The submitted config carries no string `_tag`, so the denormalized `tag`
    /// (column + wire field) can't be produced.
    InvalidConfig { message: String },
    /// A create used a client-minted id that's already taken.
    AlreadyExists { id: String },
    /// An infrastructure failure in the backing store (a checkout or query
    /// error) — opaque to clients: the HTTP layer logs `context` + `source` and
    /// answers an empty 500. The cause is captured as text so this type stays
    /// free of the store's db/`anyhow` error types.
    Backend {
        context: &'static str,
        source: String,
    },
}

impl RemoteError {
    /// Wrap an infrastructure failure (a store checkout or query error) as an
    /// opaque [`Backend`](RemoteError::Backend), capturing `context` and the
    /// cause's `Display` text. The store calls this so its db/`anyhow` error
    /// types never reach the HTTP layer.
    #[must_use]
    pub fn backend(context: &'static str, source: impl std::fmt::Display) -> Self {
        RemoteError::Backend {
            context,
            source: source.to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_tag_reads_the_string_discriminant() {
        let config = serde_json::json!({ "_tag": "fhir-r4", "rootUrl": "https://x" });
        assert_eq!(config_tag(&config), Some("fhir-r4"));
    }

    /// A missing `_tag`, a non-string `_tag`, and a non-object config all read
    /// as `None` — the write handlers turn each into a 400 rather than storing
    /// a row whose `tag` column can't be produced.
    #[test]
    fn config_tag_is_none_for_shapes_without_a_string_tag() {
        assert_eq!(
            config_tag(&serde_json::json!({ "rootUrl": "https://x" })),
            None
        );
        assert_eq!(config_tag(&serde_json::json!({ "_tag": 7 })), None);
        assert_eq!(config_tag(&serde_json::json!("fhir-r4")), None);
    }

    /// A config without a string `_tag` can't produce the `tag` column, so the
    /// write path refuses it with [`RemoteError::InvalidConfig`]; a valid tag
    /// round-trips as an owned `String`.
    #[test]
    fn required_config_tag_reads_the_tag_or_rejects() {
        assert_eq!(
            required_config_tag(&serde_json::json!({ "_tag": "fhir-r4" })),
            Ok("fhir-r4".to_owned()),
        );
        assert_eq!(
            required_config_tag(&serde_json::json!({ "rootUrl": "x" })),
            Err(RemoteError::InvalidConfig {
                message: "config._tag must be a string".to_owned(),
            }),
        );
    }

    /// The wire shape: camelCase `addedAt`, and `config` serialized as the raw
    /// JSON object — the exact shape `collector-react` decodes.
    #[test]
    fn remote_serializes_to_the_ts_wire_shape() {
        let remote = Remote {
            id: "r1".to_owned(),
            name: "One".to_owned(),
            tag: "fhir-r4".to_owned(),
            config: serde_json::json!({ "_tag": "fhir-r4", "rootUrl": "https://x" }),
            added_at: "2026-06-17T14:29:22.363Z".to_owned(),
        };
        let json = serde_json::to_value(&remote).expect("serialize");
        assert_eq!(
            json,
            serde_json::json!({
                "id": "r1",
                "name": "One",
                "tag": "fhir-r4",
                "config": { "_tag": "fhir-r4", "rootUrl": "https://x" },
                "addedAt": "2026-06-17T14:29:22.363Z",
            }),
        );
    }
}
