//! Pure types for the collector slice's host side: the [`Remote`] row/wire
//! shape and the [`config_tag`] discriminant reader.

use persistence_rust::JsonColumn;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// A stored remote — one `collector_remotes` row AND the wire shape the
/// `/collector/remotes` endpoints serve (the TS `RemoteSchema` in
/// `collector-core/src/http-api-definition/remotes.ts`). Field names double as
/// the column names (via `sql_row!` in the db layer); serde's camelCase rename
/// produces the wire's `addedAt`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
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
    /// adding a TS collector never requires a Rust change. `value_type =
    /// Value` keeps the OpenAPI schema an unconstrained `{}` (a wildcard to
    /// the TS spec-drift engine), matching that opacity.
    #[schema(value_type = Value)]
    pub config: JsonColumn<serde_json::Value>,
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

    /// The wire shape: camelCase `addedAt`, and `config` serialized as the raw
    /// JSON object (the `JsonColumn` wrapper is `#[serde(transparent)]`) — the
    /// exact shape `collector-react` decodes.
    #[test]
    fn remote_serializes_to_the_ts_wire_shape() {
        let remote = Remote {
            id: "r1".to_owned(),
            name: "One".to_owned(),
            tag: "fhir-r4".to_owned(),
            config: JsonColumn(serde_json::json!({ "_tag": "fhir-r4", "rootUrl": "https://x" })),
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
