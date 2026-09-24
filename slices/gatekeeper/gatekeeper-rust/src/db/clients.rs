//! `clients` query bodies — the `pub(super)` free functions the
//! [`SqliteGatekeeperStore`](super::SqliteGatekeeperStore) port impl delegates
//! to for [`Client`] lookup and registration/seeding upserts, each running on a
//! connection the store has already checked out of the pool. They return the
//! port's primitive shapes and raise only
//! [`GatekeeperError::Infrastructure`](crate::domain::gatekeeper_error::GatekeeperError::Infrastructure)
//! on a real db failure.

use diesel::prelude::*;
use diesel::sqlite::SqliteConnection;

use crate::db::shared::{json_text_column, text_enum_column};
use crate::domain::client::{AllowedGrantType, Client, ClientKind, RegisteredRedirectUri};
use crate::domain::gatekeeper_error::GatekeeperError;

diesel::table! {
    clients (client_id) {
        client_id -> Text,
        name -> Text,
        kind -> Text,
        redirect_uris -> Text,
        allowed_scopes -> Text,
        allowed_grant_types -> Text,
        secret_hash -> Nullable<Text>,
        registered_at -> TimestamptzSqlite,
        disabled_at -> Nullable<TimestamptzSqlite>,
    }
}

json_text_column!(
    /// A client's `redirect_uris` allowlist as a JSON TEXT column — an array of
    /// bare strings, each an absolute URL or an app-relative path (see
    /// [`RegisteredRedirectUri`]).
    JsonRedirectUris,
    Vec<RegisteredRedirectUri>
);
json_text_column!(
    /// A client's `allowed_grant_types` as a JSON TEXT column (the wire
    /// `grant_type` strings, per [`AllowedGrantType`]'s serde renames).
    JsonAllowedGrantTypes,
    Vec<AllowedGrantType>
);

// The client `kind` discriminant, stored as its strum wire string. Only the
// client binds it, so its mapping lives here rather than in `db::shared`.
text_enum_column!(ClientKind);

/// Look up a registered client by its `client_id`, or `None` when absent.
pub(super) fn client_by_id(
    conn: &mut SqliteConnection,
    client_id: &str,
) -> Result<Option<Client>, GatekeeperError> {
    clients::table
        .find(client_id)
        .select(Client::as_select())
        .first(conn)
        .optional()
        .map_err(|e| GatekeeperError::infrastructure("client_by_id failed", e))
}

/// Insert a client, or update its policy fields if one with the same
/// `client_id` already exists. Used by first-boot seeding so a seeded
/// client's definition always matches the code, even on a store created by
/// an older build. Uses `ON CONFLICT … DO UPDATE`, so it never deletes the
/// row and preserves `registered_at` and `disabled_at` — an upgrade keeps
/// the original registration time and any admin disable rather than
/// resurrecting the client.
pub(super) fn upsert_client(
    conn: &mut SqliteConnection,
    client: &Client,
) -> Result<(), GatekeeperError> {
    use diesel::upsert::excluded;
    diesel::insert_into(clients::table)
        .values(client.clone())
        .on_conflict(clients::client_id)
        .do_update()
        .set((
            clients::name.eq(excluded(clients::name)),
            clients::kind.eq(excluded(clients::kind)),
            clients::redirect_uris.eq(excluded(clients::redirect_uris)),
            clients::allowed_scopes.eq(excluded(clients::allowed_scopes)),
            clients::allowed_grant_types.eq(excluded(clients::allowed_grant_types)),
            clients::secret_hash.eq(excluded(clients::secret_hash)),
        ))
        .execute(conn)
        .map_err(|e| GatekeeperError::infrastructure("upsert_client failed", e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::{arb_opt_timestamp, arb_timestamp, arb_url};
    use crate::db::SqliteGatekeeperStore;
    use crate::domain::client::{AllowedGrantType, ClientKind};
    use crate::domain::GatekeeperStore as _;
    use proptest::prelude::*;

    /// A registered redirect entry: an absolute URL or an app-relative path
    /// (leading `/`, never `//`), so the round-trip covers both stored forms.
    fn arb_registered_redirect() -> impl Strategy<Value = RegisteredRedirectUri> {
        prop_oneof![
            arb_url().prop_map(RegisteredRedirectUri::Absolute),
            "/[a-z][a-z0-9/_-]{0,15}".prop_map(RegisteredRedirectUri::AppRelative),
        ]
    }

    fn arb_client() -> impl Strategy<Value = Client> {
        (
            "[a-zA-Z0-9_-]{1,32}",
            "[ -~]{0,48}",
            prop_oneof![Just(ClientKind::Public), Just(ClientKind::Confidential)],
            prop::collection::vec(arb_registered_redirect(), 1..4),
            prop::collection::vec("[a-z][a-z0-9_]{0,15}", 0..5),
            prop::option::of("[0-9a-f]{64}"),
            arb_timestamp(),
            arb_opt_timestamp(),
        )
            .prop_map(
                |(
                    client_id,
                    name,
                    kind,
                    redirect_uris,
                    allowed_scopes,
                    secret_hash,
                    registered_at,
                    disabled_at,
                )| Client {
                    client_id,
                    name,
                    kind,
                    redirect_uris,
                    allowed_scopes,
                    allowed_grant_types: AllowedGrantType::ALL.to_vec(),
                    secret_hash,
                    registered_at,
                    disabled_at,
                },
            )
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(48))]

        #[test]
        fn upsert_and_fetch_round_trip(client in arb_client()) {
            let store = SqliteGatekeeperStore::open_in_memory().expect("open in-memory store");
            store.upsert_client(&client).expect("upsert");
            let fetched = store
                .client_by_id(&client.client_id)
                .expect("query")
                .expect("row present");
            prop_assert_eq!(fetched, client);
        }
    }

    #[test]
    fn upsert_updates_policy_but_preserves_registration_and_disable() {
        let store = SqliteGatekeeperStore::open_in_memory().expect("open in-memory store");
        let registered_at = chrono::DateTime::from_timestamp(1_000, 0).unwrap();
        let disabled_at = chrono::DateTime::from_timestamp(1_500, 0).unwrap();
        let mut client = Client {
            client_id: "c1".to_string(),
            name: "First".to_string(),
            kind: ClientKind::Public,
            redirect_uris: vec![],
            allowed_scopes: vec!["openid".to_string()],
            allowed_grant_types: AllowedGrantType::ALL.to_vec(),
            secret_hash: None,
            registered_at,
            disabled_at: Some(disabled_at),
        };
        store.upsert_client(&client).expect("insert");

        // Re-seed with drifted policy, a newer registered_at, and disabled_at
        // cleared: the policy fields update, but registration time and the admin
        // disable are preserved (the row is updated in place, never resurrected).
        client.name = "Renamed".to_string();
        client.allowed_scopes = vec!["system/*.cruds".to_string()];
        client.registered_at = chrono::DateTime::from_timestamp(2_000, 0).unwrap();
        client.disabled_at = None;
        store.upsert_client(&client).expect("update");

        let fetched = store
            .client_by_id("c1")
            .expect("query")
            .expect("row present");
        assert_eq!(fetched.name, "Renamed");
        assert_eq!(fetched.allowed_scopes, vec!["system/*.cruds".to_string()]);
        assert_eq!(fetched.registered_at, registered_at);
        assert_eq!(fetched.disabled_at, Some(disabled_at));
    }

    /// Every SMART client is seeded by a migration (not Rust) — the sample apps by
    /// `0003`, the two first-party apps by `0004` / `0005` (renamed and given
    /// their published-site redirect by `0006`), the server-docs API console by
    /// `0007`, the Importer by `0008`, and the OHIF imaging viewer by `0009` — so a
    /// freshly-migrated store has them all, and every hand-written row decodes
    /// back to a valid `Client`. This is the guard that the SQL seeds' JSON
    /// columns and `registered_at` text stay in the exact shape the store's read
    /// path parses (a malformed value would fail `client_by_id`'s row mapping,
    /// not silently).
    #[test]
    fn migrations_seed_the_smart_app_clients() {
        let store = SqliteGatekeeperStore::open_in_memory().expect("open in-memory store");
        for client_id in [
            "growth_chart",
            "my_web_app",
            "cc344727-6f90-496c-94fd-c7829aa9a51d",
            "medications-app",
            "web-trace-app",
            "wildflower-server-docs",
            "wildflower-react",
            "importer-app",
            "ohif-viewer",
        ] {
            let client = store
                .client_by_id(client_id)
                .expect("query (a decode failure surfaces here)")
                .unwrap_or_else(|| panic!("{client_id} is seeded by a clients migration"));
            assert_eq!(client.client_id, client_id);
            assert_eq!(client.kind, ClientKind::Public);
            assert!(
                client.secret_hash.is_none(),
                "{client_id} is a public client"
            );
            assert!(!client.allowed_scopes.is_empty());
            assert!(!client.redirect_uris.is_empty());
            assert!(!client.allowed_grant_types.is_empty());
        }

        // `my_web_app` (the Medication Viewer registration) carries the exact
        // scope + redirect from the review comment.
        let mwa = store.client_by_id("my_web_app").unwrap().unwrap();
        assert_eq!(
            mwa.allowed_scopes,
            vec![
                "launch".to_string(),
                "openid".to_string(),
                "fhirUser".to_string(),
                "patient/*.read".to_string(),
            ],
        );
        assert_eq!(
            mwa.redirect_uris[0]
                .absolute()
                .expect("a seeded absolute redirect")
                .as_str(),
            "https://mitre.github.io/smart-on-fhir-demo/index.html",
        );
        assert_eq!(
            mwa.allowed_grant_types,
            vec![
                AllowedGrantType::AuthorizationCode,
                AllowedGrantType::RefreshToken
            ],
        );

        // `web-trace-app` (the Web Trace viewer) pins three decisions across its
        // seed (`0005`) and the rename (`0006`): the **app-relative** redirect,
        // kept because a self-hosted origin differs per launch (loopback vs
        // tunnel) and isn't known at seed time; the **absolute** published-site
        // redirect the app now actually launches from as a cloud app (a cloud
        // app has no self-hosted row for the relative form to resolve against);
        // and a read-only `system/` resource scope, because trace
        // `DocumentReference`s carry no `subject` and so aren't reachable through
        // patient context.
        let web_trace = store.client_by_id("web-trace-app").unwrap().unwrap();
        assert_eq!(
            web_trace.redirect_uris,
            vec![
                RegisteredRedirectUri::AppRelative("/".to_owned()),
                RegisteredRedirectUri::Absolute(
                    "https://wildflowerhealth.io/web-trace-app/"
                        .parse()
                        .expect("a valid absolute redirect"),
                ),
            ],
        );
        assert_eq!(
            web_trace.allowed_scopes,
            vec![
                "launch".to_string(),
                "openid".to_string(),
                "fhirUser".to_string(),
                "system/DocumentReference.read".to_string(),
            ],
        );

        // The old `medication_viewer` id is gone — replaced by `my_web_app`, and
        // the pre-rename first-party ids are gone with `0006`.
        for retired in [
            "medication_viewer",
            "wildflower-medication",
            "wildflower-web-trace",
        ] {
            assert!(
                store.client_by_id(retired).unwrap().is_none(),
                "{retired} must no longer be registered",
            );
        }

        // `medications-app` keeps its app-relative entry (for the debug-only
        // self-hosted dev row) and gains the absolute published-site redirect it
        // launches from as a cloud app.
        let medications = store.client_by_id("medications-app").unwrap().unwrap();
        assert_eq!(
            medications.redirect_uris,
            vec![
                RegisteredRedirectUri::AppRelative("/".to_owned()),
                RegisteredRedirectUri::Absolute(
                    "https://wildflowerhealth.io/medications-app/"
                        .parse()
                        .expect("a valid absolute redirect"),
                ),
            ],
        );

        // The server-docs API console is a standalone-launch client, so it is
        // registered with the MAXIMAL scope vocabulary and narrowed at consent
        // (`grantable_scopes` clamps an approval to requested ∧ allowed). The
        // three wildcards can't be collapsed further: `wildflower/launch` is a
        // *known* scope no wildcard covers, and the FHIR and Wildflower resource
        // grammars are disjoint.
        let docs = store
            .client_by_id("wildflower-server-docs")
            .unwrap()
            .unwrap();
        assert_eq!(
            docs.redirect_uris,
            vec![RegisteredRedirectUri::Absolute(
                "https://wildflowerhealth.io/wildflower-server-docs/"
                    .parse()
                    .expect("a valid absolute redirect"),
            )],
        );
        assert_eq!(
            docs.allowed_scopes,
            vec![
                "openid".to_string(),
                "profile".to_string(),
                "fhirUser".to_string(),
                "launch".to_string(),
                "launch/patient".to_string(),
                "offline_access".to_string(),
                "wildflower/launch".to_string(),
                "system/*.cruds".to_string(),
                "wildflower/*.cruds".to_string(),
            ],
        );
        // Every scope the console might request is genuinely covered by what it
        // is allowed — the property the migration's comment claims, checked
        // against the live grammar rather than by eye.
        for requested in [
            "patient/Observation.read",
            "user/Patient.rs",
            "system/*.read",
            "system/MedicationRequest.cruds",
            "wildflower/Grant.r",
            "wildflower/Apps.cruds",
            "wildflower/launch",
            "offline_access",
        ] {
            assert!(
                docs.allowed_scopes
                    .iter()
                    .any(|allowed| scopes_rust::allowed_scope_covers(allowed, requested)),
                "the console's allowed scopes must cover {requested}",
            );
        }
        // The web owner UI (`apps/wildflower-react`'s `main-web` build) is a
        // standalone-launch client for the same reason the console is — it drives
        // every slice surface — so `0012` registers it against the console's
        // vocabulary rather than a set of its own. Compared against `docs` rather
        // than a second literal copy: a scope added to one migration and not the
        // other fails here instead of drifting quietly.
        let web_client = store.client_by_id("wildflower-react").unwrap().unwrap();
        assert_eq!(web_client.allowed_scopes, docs.allowed_scopes);
        assert_eq!(web_client.allowed_grant_types, docs.allowed_grant_types);
        // One absolute entry, and it is the app ROOT (`0013` replaced 0012's
        // `/home`): the web UI is a SPA on browser history, so
        // `redirectUriForRoute` derives the served root per origin (the
        // directory form would vary by whichever section the reader signed in
        // from), and the reader's destination rides the client's pending record.
        // Any other origin the build runs at is trusted on first use through the
        // consent prompt, so this single entry is the published address only.
        assert_eq!(
            web_client.redirect_uris,
            vec![RegisteredRedirectUri::Absolute(
                "https://wildflowerhealth.io/app/"
                    .parse()
                    .expect("a valid absolute redirect"),
            )],
        );

        // `importer-app` (the Importer) is a cloud client like `medications-app`
        // and `web-trace-app`: the app-relative `"/"` for the debug-only
        // self-hosted dev row, plus the absolute published-site redirect it
        // launches from as a cloud app (seeded by `0008`). It is the one seeded
        // SMART client whose scopes **carry writes**: importing persists what a
        // captured session contained. The set `0008` seeded was widened by
        // `0009_widen_importer_client_write_scopes` to add `Practitioner`,
        // `DiagnosticReport`, `Medication`, `MedicationRequest`,
        // `MedicationDispense`, `ServiceRequest`, and `ImagingStudy`, and to
        // broaden every type to full `.cruds` (create + read + update + delete +
        // search). This vector must stay element-for-element
        // equal to the `scope` string in `apps/importer-web/src/config.ts` —
        // nothing spans the TS/Rust boundary to check it, so this assertion is the
        // Rust-side mirror of that pin, and a scope added on one side alone fails
        // `/authorize` on a real device.
        let importer = store.client_by_id("importer-app").unwrap().unwrap();
        assert_eq!(
            importer.redirect_uris,
            vec![
                RegisteredRedirectUri::AppRelative("/".to_owned()),
                RegisteredRedirectUri::Absolute(
                    "https://wildflowerhealth.io/importer-app/"
                        .parse()
                        .expect("a valid absolute redirect"),
                ),
            ],
        );
        assert_eq!(
            importer.allowed_scopes,
            vec![
                "launch".to_string(),
                "openid".to_string(),
                "fhirUser".to_string(),
                "system/DocumentReference.cruds".to_string(),
                "system/Patient.cruds".to_string(),
                "system/Observation.cruds".to_string(),
                "system/Practitioner.cruds".to_string(),
                "system/DiagnosticReport.cruds".to_string(),
                "system/Medication.cruds".to_string(),
                "system/MedicationRequest.cruds".to_string(),
                "system/MedicationDispense.cruds".to_string(),
                "system/ServiceRequest.cruds".to_string(),
                "system/ImagingStudy.cruds".to_string(),
            ],
        );
        // `ohif-viewer` (the OHIF imaging viewer) is a cloud client like the three
        // above, seeded by `0009` and repointed onto the `/fhir-viewer` route by
        // `0010`, and read-only. This vector must stay
        // element-for-element equal to the `smartScope` string in
        // `apps/ohif-viewer/config/app-config.js` — nothing spans the JS/Rust
        // boundary to check it, so this assertion is the Rust-side mirror of that
        // pin, and a scope added on one side alone fails `/authorize` on a real
        // device.
        let ohif = store.client_by_id("ohif-viewer").unwrap().unwrap();
        assert_eq!(
            ohif.redirect_uris,
            vec![
                RegisteredRedirectUri::AppRelative("/".to_owned()),
                RegisteredRedirectUri::Absolute(
                    "https://wildflowerhealth.io/ohif-viewer/fhir-viewer"
                        .parse()
                        .expect("a valid absolute redirect"),
                ),
            ],
        );
        assert_eq!(
            ohif.allowed_scopes,
            vec![
                "launch".to_string(),
                "openid".to_string(),
                "fhirUser".to_string(),
                "system/Patient.rs".to_string(),
                "system/ImagingStudy.rs".to_string(),
                "system/DocumentReference.rs".to_string(),
            ],
        );
    }

    /// Each of the client row's custom column mappings rejects an out-of-domain
    /// stored value on read as a typed diesel error, never a panic: the JSON TEXT
    /// newtypes ([`JsonRedirectUris`](super::JsonRedirectUris) / [`JsonStrings`](crate::db::shared::JsonStrings)
    /// / [`JsonAllowedGrantTypes`](super::JsonAllowedGrantTypes)) on malformed JSON
    /// or an unknown enum member, and the [`ClientKind`] text-enum mapping on an
    /// unknown discriminant. A row tampered via raw SQL surfaces at the
    /// `client_by_id` read boundary as `Err`, so a corrupt row can never silently
    /// decode to a wrong-but-valid client.
    #[test]
    fn stored_columns_reject_corrupt_values() {
        // `column = bad_value` tampered onto the migration-seeded `growth_chart`
        // row, each asserted to fail the read.
        for (column, bad_value) in [
            ("redirect_uris", "not json"), // JsonRedirectUris: malformed JSON
            ("redirect_uris", "[\"not a url\"]"), // JsonRedirectUris: valid JSON, neither URL nor path
            ("allowed_scopes", "not json"),       // JsonStrings: malformed JSON
            ("allowed_grant_types", "[\"totally_unknown\"]"), // JsonAllowedGrantTypes: unknown member
            ("kind", "bogus_kind"),                           // ClientKind: unknown discriminant
        ] {
            let store = SqliteGatekeeperStore::open_in_memory().expect("open in-memory store");
            let mut conn = store.pool().get().expect("check out a connection");
            diesel::sql_query(format!(
                "UPDATE clients SET {column} = '{bad_value}' WHERE client_id = 'growth_chart'"
            ))
            .execute(&mut conn)
            .expect("tamper the stored row");
            drop(conn);
            assert!(
                store.client_by_id("growth_chart").is_err(),
                "a corrupt `{column}` must surface as a typed read error",
            );
        }
    }
}
