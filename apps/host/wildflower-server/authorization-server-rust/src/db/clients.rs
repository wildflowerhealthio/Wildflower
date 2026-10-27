//! `clients` — the registered OAuth clients, loaded and stored as
//! [`Client`]: the [`ClientsTx`] primitives on [`SqliteGrantTx`].

use chrono::{DateTime, Utc};
use diesel::prelude::*;

use crate::db::grant_store::SqliteGrantTx;
use crate::db::shared::{json_text_column, text_enum_column};
use crate::domain::authorization_server_error::AuthorizationServerError;
use crate::domain::client::{AllowedGrantType, Client, ClientKind, RegistrationSource};
use crate::domain::grant_store::ClientsTx;

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
        registration_source -> Text,
    }
}

json_text_column!(
    /// A client's `redirect_uris` allowlist as a JSON TEXT column — an array of
    /// absolute URL strings.
    JsonUrls,
    Vec<url::Url>
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

// Who defines the registration, stored as its strum wire string.
text_enum_column!(RegistrationSource);

impl ClientsTx for SqliteGrantTx<'_> {
    /// Look up a registered client by its `client_id`, or `None` when absent.
    fn client_by_id(
        &mut self,
        client_id: &str,
    ) -> Result<Option<Client>, AuthorizationServerError> {
        let conn = &mut *self.conn;
        clients::table
            .find(client_id)
            .select(Client::as_select())
            .first(conn)
            .optional()
            .map_err(|e| AuthorizationServerError::infrastructure("client_by_id failed", e))
    }

    /// One read of the client's `disabled_at`; a client with no row reads as
    /// enabled.
    fn is_client_disabled(&mut self, client_id: &str) -> Result<bool, AuthorizationServerError> {
        let conn = &mut *self.conn;
        let disabled_at = clients::table
            .find(client_id)
            .select(clients::disabled_at)
            .first::<Option<DateTime<Utc>>>(conn)
            .optional()
            .map_err(|e| {
                AuthorizationServerError::infrastructure("is_client_disabled failed", e)
            })?;
        Ok(disabled_at.flatten().is_some())
    }

    /// Every registered client, ordered by `client_id`.
    fn list_clients(&mut self) -> Result<Vec<Client>, AuthorizationServerError> {
        let conn = &mut *self.conn;
        clients::table
            .order(clients::client_id.asc())
            .select(Client::as_select())
            .load(conn)
            .map_err(|e| AuthorizationServerError::infrastructure("list_clients failed", e))
    }

    /// Set or clear a client's `disabled_at`, returning whether a row matched. Only
    /// the one column is written, so the client's registration (redirects, scopes,
    /// secret, `registered_at`) survives a disable → enable round trip unchanged.
    fn set_client_disabled(
        &mut self,
        client_id: &str,
        disabled_at: Option<DateTime<Utc>>,
    ) -> Result<bool, AuthorizationServerError> {
        let conn = &mut *self.conn;
        let updated = diesel::update(clients::table.find(client_id))
            .set(clients::disabled_at.eq(disabled_at))
            .execute(conn)
            .map_err(|e| {
                AuthorizationServerError::infrastructure("set_client_disabled failed", e)
            })?;
        Ok(updated > 0)
    }

    /// Insert a client, or update its policy fields if one with the same
    /// `client_id` already exists. Used by the seeding every boot runs, so a
    /// seeded client's definition always matches the code, and by the grant
    /// recorder's trust-on-first-use registration. Uses `ON CONFLICT … DO
    /// UPDATE`, so it never deletes the row and preserves `registered_at` and
    /// `disabled_at` — the original registration time and any admin disable
    /// survive rather than the client being resurrected.
    fn upsert_client(&mut self, client: &Client) -> Result<(), AuthorizationServerError> {
        let conn = &mut *self.conn;
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
                clients::registration_source.eq(excluded(clients::registration_source)),
            ))
            .execute(conn)
            .map_err(|e| AuthorizationServerError::infrastructure("upsert_client failed", e))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::{arb_opt_timestamp, arb_timestamp, arb_url};
    use crate::db::SqliteGrantStore;
    use crate::domain::client::{AllowedGrantType, ClientKind};
    use crate::domain::grant_store::*;
    use proptest::prelude::*;

    /// A client with every field drawn independently: public or confidential,
    /// server-defined or trusted on first use, disabled or not.
    fn arb_client() -> impl Strategy<Value = Client> {
        (
            "[a-zA-Z0-9_-]{1,32}",
            "[ -~]{0,48}",
            prop_oneof![Just(ClientKind::Public), Just(ClientKind::Confidential)],
            prop::collection::vec(arb_url(), 1..4),
            prop::collection::vec("[a-z][a-z0-9_]{0,15}", 0..5),
            prop::option::of("[0-9a-f]{64}"),
            arb_timestamp(),
            arb_opt_timestamp(),
            prop_oneof![
                Just(RegistrationSource::ServerDefined),
                Just(RegistrationSource::TrustedOnFirstUse)
            ],
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
                    registration_source,
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
                    registration_source,
                },
            )
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(48))]

        /// Any client upserted into a fresh store reads back by its id exactly as
        /// written.
        #[test]
        fn upsert_and_fetch_round_trip(client in arb_client()) {
            let store = SqliteGrantStore::open_in_memory().expect("open in-memory store");
            store.write(|tx| tx.upsert_client(&client)).expect("upsert");
            let fetched = store
                .read(|tx| tx.client_by_id(&client.client_id))
                .expect("query")
                .expect("row present");
            prop_assert_eq!(fetched, client);
        }
    }

    /// The migrations seed a fixed set of clients, so the list/disable
    /// properties run against the delta the test itself upserts.
    fn seeded_client_ids(store: &SqliteGrantStore) -> Vec<String> {
        store
            .read(|tx| tx.list_clients())
            .expect("list seeded clients")
            .into_iter()
            .map(|c| c.client_id)
            .collect()
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(32))]

        /// `list_clients` returns every stored row — the migration seeds plus
        /// whatever was upserted — exactly once each, sorted by `client_id`, with
        /// each upserted row decoding back unchanged.
        #[test]
        fn list_clients_returns_every_row_sorted_by_id(
            upserted in prop::collection::vec(arb_client(), 0..6),
        ) {
            let store = SqliteGrantStore::open_in_memory().expect("open in-memory store");
            let mut expected: std::collections::BTreeMap<String, Client> = store
                .read(|tx| tx.list_clients())
                .expect("list seeds")
                .into_iter()
                .map(|c| (c.client_id.clone(), c))
                .collect();
            for client in &upserted {
                // Fresh ids only: a repeat upsert keeps the first row's
                // `registered_at` / `disabled_at` by design, which is
                // `upsert_client`'s property, not this one's.
                if !expected.contains_key(&client.client_id) {
                    store.write(|tx| tx.upsert_client(client)).expect("upsert");
                    expected.insert(client.client_id.clone(), client.clone());
                }
            }

            let listed = store.read(|tx| tx.list_clients()).expect("list");
            prop_assert_eq!(listed, expected.into_values().collect::<Vec<_>>());
        }

        /// Setting then clearing `disabled_at` touches only that column: every
        /// other field of the row reads back exactly as registered, and the
        /// stamp itself reads back as written at each step.
        #[test]
        fn set_client_disabled_round_trips_only_the_stamp(
            client in arb_client(),
            stamp in arb_timestamp(),
        ) {
            let store = SqliteGrantStore::open_in_memory().expect("open in-memory store");
            // A seeded id would keep the seed's policy on upsert; use a fresh one.
            prop_assume!(!seeded_client_ids(&store).contains(&client.client_id));
            store.write(|tx| tx.upsert_client(&client)).expect("upsert");

            prop_assert!(store.write(|tx| tx.set_client_disabled(&client.client_id, Some(stamp))).expect("disable"));
            let disabled = store.read(|tx| tx.client_by_id(&client.client_id)).expect("query").expect("row");
            prop_assert_eq!(&disabled, &Client { disabled_at: Some(stamp), ..client.clone() });

            prop_assert!(store.write(|tx| tx.set_client_disabled(&client.client_id, None)).expect("enable"));
            let enabled = store.read(|tx| tx.client_by_id(&client.client_id)).expect("query").expect("row");
            prop_assert_eq!(enabled, Client { disabled_at: None, ..client });
        }

        /// An id with no row reports `false` and creates nothing.
        #[test]
        fn set_client_disabled_on_an_unknown_id_is_a_miss(
            client_id in "[a-zA-Z0-9_-]{1,32}",
            stamp in arb_opt_timestamp(),
        ) {
            let store = SqliteGrantStore::open_in_memory().expect("open in-memory store");
            let before = seeded_client_ids(&store);
            prop_assume!(!before.contains(&client_id));
            prop_assert!(!store.write(|tx| tx.set_client_disabled(&client_id, stamp)).expect("update"));
            prop_assert_eq!(seeded_client_ids(&store), before);
        }
    }

    /// Upserting an existing client updates its name and policy in place but
    /// keeps its first `registered_at` and the Owner's disable.
    #[test]
    fn upsert_updates_policy_but_preserves_registration_and_disable() {
        let store = SqliteGrantStore::open_in_memory().expect("open in-memory store");
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
            registration_source: RegistrationSource::TrustedOnFirstUse,
        };
        store.write(|tx| tx.upsert_client(&client)).expect("insert");

        // Re-seed with drifted policy, a newer registered_at, and disabled_at
        // cleared: the policy fields update, but registration time and the admin
        // disable are preserved (the row is updated in place, never resurrected).
        client.name = "Renamed".to_string();
        client.allowed_scopes = vec!["system/*.cruds".to_string()];
        client.registered_at = chrono::DateTime::from_timestamp(2_000, 0).unwrap();
        client.disabled_at = None;
        client.registration_source = RegistrationSource::ServerDefined;
        store.write(|tx| tx.upsert_client(&client)).expect("update");

        let fetched = store
            .read(|tx| tx.client_by_id("c1"))
            .expect("query")
            .expect("row present");
        assert_eq!(fetched.name, "Renamed");
        assert_eq!(fetched.allowed_scopes, vec!["system/*.cruds".to_string()]);
        assert_eq!(fetched.registered_at, registered_at);
        assert_eq!(fetched.disabled_at, Some(disabled_at));
        assert_eq!(
            fetched.registration_source,
            RegistrationSource::ServerDefined,
            "seeding marks the rows it owns server-defined"
        );
    }

    /// Every SMART client is seeded by a migration (not Rust) — the sample apps by
    /// `0003`, Medications by `0004` (renamed and given its published-site
    /// redirect by `0006`), the server-docs API console by
    /// `0007`, the Importer by `0008`, the OHIF imaging viewer by `0009`
    /// (re-seeded by `0016` on an install that skipped it), FHIR Sync for
    /// Pebble by `0017` (its Observation scope widened by `0018`), Strength by
    /// `0019`, Plots by `0022` (both renamed by `0035`), and the Synthetic Data
    /// Loader by `0028` (which re-keys Medications, the console, the Importer and
    /// Plots to random ids, as `0025` / `0026` did Strength and the
    /// launcher, `0029` does the OHIF viewer and `0030` FHIR Sync for Pebble), and
    /// Wildflower Authorization by `0031` (the launcher's scopes are narrowed by
    /// `0032`), and `0037` puts each hosted app's own origin in front of the
    /// redirect on `wildflowerhealth.io` it held — so a
    /// freshly-migrated store has them all, and every hand-written row decodes
    /// back to a valid `Client`. This is the guard that the SQL seeds' JSON
    /// columns and `registered_at` text stay in the exact shape the store's read
    /// path parses (a malformed value would fail `client_by_id`'s row mapping,
    /// not silently).
    #[test]
    fn migrations_seed_the_smart_app_clients() {
        let store = SqliteGrantStore::open_in_memory().expect("open in-memory store");
        for client_id in [
            "growth_chart",
            "my_web_app",
            "cc344727-6f90-496c-94fd-c7829aa9a51d",
            "9769f8b274370708d0d3ebb2e3e59b7c",
            "664a01e8614050cd82ffe90350b81413",
            "03a513940b52f8c2649a5366d1a26d19",
            "165cd26573e5ac72378e6ad2d2198330",
            "941de68e6b59eb9dcc32df8ede89e636",
            "6847df97d54c31936d54ca1b36b3bb09",
            "bdf9fc5cb5a28c6683b49896b0ef8a75",
            "474e103de61f9141c4b640d59bfa130e",
            "225ba6af034a3acec6be7ff8010df67f",
            "7277e898bee8ac81ea44788236e619a5",
        ] {
            let client = store
                .read(|tx| tx.client_by_id(client_id))
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
        let mwa = store
            .read(|tx| tx.client_by_id("my_web_app"))
            .unwrap()
            .unwrap();
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
            mwa.redirect_uris[0].as_str(),
            "https://mitre.github.io/smart-on-fhir-demo/index.html",
        );
        assert_eq!(
            mwa.allowed_grant_types,
            vec![
                AllowedGrantType::AuthorizationCode,
                AllowedGrantType::RefreshToken
            ],
        );

        // The old `medication_viewer` id is gone — replaced by `my_web_app` —
        // the pre-rename first-party ids are gone with `0006`, the Web Trace
        // clients with `0027`, and the ids `0028` re-keyed with it.
        for retired in [
            "medication_viewer",
            "wildflower-medication",
            "wildflower-web-trace",
            "web-trace-app",
            "web-trace-app-dev",
            "medications-app",
            "wildflower-server-docs",
            "importer-app",
            "health-viewer-app",
        ] {
            assert!(
                store.read(|tx| tx.client_by_id(retired)).unwrap().is_none(),
                "{retired} must no longer be registered",
            );
        }

        // Medications carries the published-site redirect it launches from.
        let medications = store
            .read(|tx| tx.client_by_id("9769f8b274370708d0d3ebb2e3e59b7c"))
            .unwrap()
            .unwrap();
        assert_eq!(
            medications.redirect_uris,
            vec![
                url::Url::parse("https://medications.wildflowerhealth.io/")
                    .expect("a valid absolute redirect"),
                url::Url::parse("https://wildflowerhealth.io/medications/")
                    .expect("a valid absolute redirect"),
            ],
        );
        // Its scopes are `system/` reads only, with no `launch/patient`: the app
        // picks the patient itself, reading `Patient` for the picker (`0020`).
        // This vector must stay element-for-element equal to
        // `MEDICATIONS_SCOPE` in `apps/medications/medications-web/src/config.ts`;
        // `seeding.rs`'s `seeds_the_medications_dev_client_with_the_apps_own_scopes`
        // reads that file and pins this client to it.
        assert_eq!(
            medications.allowed_scopes,
            vec![
                "launch".to_string(),
                "openid".to_string(),
                "fhirUser".to_string(),
                "system/MedicationRequest.rs".to_string(),
                "system/Medication.rs".to_string(),
                "system/Patient.rs".to_string(),
            ],
        );

        // The server-docs API console is a standalone-launch client, so it is
        // registered with the MAXIMAL scope vocabulary and narrowed at consent
        // (`grantable_scopes` clamps an approval to requested ∧ allowed). The
        // three wildcards can't be collapsed further: `wildflower/launch` is a
        // *known* scope no wildcard covers, and the FHIR and Wildflower resource
        // grammars are disjoint.
        let docs = store
            .read(|tx| tx.client_by_id("664a01e8614050cd82ffe90350b81413"))
            .unwrap()
            .unwrap();
        assert_eq!(
            docs.redirect_uris,
            vec![
                url::Url::parse("https://server-docs.wildflowerhealth.io/")
                    .expect("a valid absolute redirect"),
                url::Url::parse("https://wildflowerhealth.io/server-docs/")
                    .expect("a valid absolute redirect"),
            ],
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
                docs.allowed_scopes.iter().any(|allowed| {
                    wildflowerhealthio_scopes::allowed_scope_covers(allowed, requested)
                }),
                "the console's allowed scopes must cover {requested}",
            );
        }
        // The launcher (`apps/launcher/launcher-web`'s `main-web` build), seeded
        // by `0012`, re-keyed to a random id and renamed by `0026`. Its scopes
        // are pinned to the app by
        // `migrations_narrow_the_launcher_client_to_the_apps_own_scopes`.
        let web_client = store
            .read(|tx| tx.client_by_id("03a513940b52f8c2649a5366d1a26d19"))
            .unwrap()
            .unwrap();
        assert_eq!(web_client.name, "Wildflower Launcher");
        assert_eq!(
            web_client.allowed_grant_types,
            vec![
                AllowedGrantType::AuthorizationCode,
                AllowedGrantType::RefreshToken,
            ],
        );
        // Absolute entries only, each the app ROOT (`0013` replaced 0012's
        // `/home`; `0026` moved it to `/launcher/`; `0037` added the app's own
        // origin in front): the web UI is a SPA on browser history, so
        // `redirectUriForRoute` derives the served root per origin (the
        // directory form would vary by whichever section the reader signed in
        // from), and the reader's destination rides the client's pending record.
        // Any other origin the build runs at is trusted on first use through the
        // consent prompt, so these entries are the published addresses only.
        assert_eq!(
            web_client.redirect_uris,
            vec![
                url::Url::parse("https://launcher.wildflowerhealth.io/")
                    .expect("a valid absolute redirect"),
                url::Url::parse("https://wildflowerhealth.io/launcher/")
                    .expect("a valid absolute redirect"),
            ],
        );

        // The Importer carries the published-site redirect it
        // launches from (seeded by `0008`). It is the one seeded
        // SMART client whose scopes **carry writes**: importing persists what a
        // captured session contained. The set `0008` seeded was widened by
        // `0009_widen_importer_client_write_scopes` to add `Practitioner`,
        // `DiagnosticReport`, `Medication`, `MedicationRequest`,
        // `MedicationDispense`, `ServiceRequest`, and `ImagingStudy`, and to
        // broaden every type to full `.cruds` (create + read + update + delete +
        // search) — re-applied by `0015` on an install that skipped it. This
        // vector must stay element-for-element equal to the `scope` string in
        // `apps/importer-web/src/config.ts` —
        // nothing spans the TS/Rust boundary to check it, so this assertion is the
        // Rust-side mirror of that pin, and a scope added on one side alone fails
        // `/authorize` on a real device.
        let importer = store
            .read(|tx| tx.client_by_id("165cd26573e5ac72378e6ad2d2198330"))
            .unwrap()
            .unwrap();
        assert_eq!(
            importer.redirect_uris,
            vec![
                url::Url::parse("https://importer.wildflowerhealth.io/")
                    .expect("a valid absolute redirect"),
                url::Url::parse("https://wildflowerhealth.io/importer/")
                    .expect("a valid absolute redirect"),
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
        // The OHIF imaging viewer's client (seeded by `0009` as `ohif-viewer`,
        // re-keyed to a random id by `0029`) carries its published-site
        // redirect, repointed onto the `/fhir-viewer` route by `0010`, and is
        // read-only. This vector must stay
        // element-for-element equal to the `smartScope` string in
        // `apps/ohif-viewer-web/config/app-config.js` — nothing spans the JS/Rust
        // boundary to check it, so this assertion is the Rust-side mirror of that
        // pin, and a scope added on one side alone fails `/authorize` on a real
        // device.
        let ohif = store
            .read(|tx| tx.client_by_id("941de68e6b59eb9dcc32df8ede89e636"))
            .unwrap()
            .unwrap();
        assert_eq!(
            ohif.redirect_uris,
            vec![
                url::Url::parse("https://ohif-viewer.wildflowerhealth.io/fhir-viewer")
                    .expect("a valid absolute redirect"),
                url::Url::parse("https://wildflowerhealth.io/ohif-viewer/fhir-viewer")
                    .expect("a valid absolute redirect"),
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
        // FHIR Sync for Pebble's client (the Pebble watchapp's settings page,
        // seeded by `0017` as `fhir-sync-pebble`, re-keyed to a random id by
        // `0030`) is standalone-only: it carries its published-site redirect, and its scopes
        // are `system/`, with no `launch`: the page picks the patient after the
        // grant.
        // This vector must stay element-for-element equal to the `scope` string
        // in `apps/fhir-sync-pebble/fhir-sync-pebble-web/src/config.ts` — nothing spans the
        // TS/Rust boundary to check it.
        let pebble = store
            .read(|tx| tx.client_by_id("6847df97d54c31936d54ca1b36b3bb09"))
            .unwrap()
            .unwrap();
        assert_eq!(
            pebble.redirect_uris,
            vec![
                url::Url::parse("https://fhir-sync-pebble.wildflowerhealth.io/")
                    .expect("a valid absolute redirect"),
                url::Url::parse("https://wildflowerhealth.io/fhir-sync-pebble/")
                    .expect("a valid absolute redirect"),
            ],
        );
        assert_eq!(
            pebble.allowed_scopes,
            vec![
                "openid".to_string(),
                "fhirUser".to_string(),
                "system/Patient.rs".to_string(),
                "system/Observation.cu".to_string(),
            ],
        );
        // Strength's client (seeded by `0019` as `lifting-app`, re-keyed to a
        // random id by `0025`) carries its published-site redirect, and its
        // scopes carry writes: the training plan
        // definition's `PlanDefinition`, a `ServiceRequest` per exercise, and
        // each workout's `Procedure` and per-set `Observation`s. There is no
        // `launch/patient`: the app picks the lifter itself (`0020`).
        // This vector must stay element-for-element equal to `STRENGTH_SCOPE` in
        // `apps/strength/strength-web/src/config.ts`; `seeding.rs`'s
        // `seeds_the_strength_dev_client_with_the_apps_own_scopes` reads that
        // file and pins this client to it.
        let strength = store
            .read(|tx| tx.client_by_id("bdf9fc5cb5a28c6683b49896b0ef8a75"))
            .unwrap()
            .unwrap();
        assert_eq!(
            strength.redirect_uris,
            vec![
                url::Url::parse("https://strength.wildflowerhealth.io/")
                    .expect("a valid absolute redirect"),
                url::Url::parse("https://wildflowerhealth.io/lifting/")
                    .expect("a valid absolute redirect"),
            ],
        );
        assert_eq!(
            strength.allowed_scopes,
            vec![
                "launch".to_string(),
                "openid".to_string(),
                "fhirUser".to_string(),
                "system/Patient.rs".to_string(),
                "system/PlanDefinition.crus".to_string(),
                "system/ServiceRequest.crus".to_string(),
                "system/Procedure.crus".to_string(),
                "system/Observation.crus".to_string(),
            ],
        );
        assert_eq!(
            strength.allowed_grant_types,
            vec![
                AllowedGrantType::AuthorizationCode,
                AllowedGrantType::RefreshToken,
            ],
        );
        // Plots' client carries its published-site redirect,
        // seeded by `0022` and moved by `0028`, and read-only scopes. Its
        // scopes are pinned to `apps/plots/plots-web/src/config.ts` by
        // `seeding.rs`'s `seeds_the_plots_dev_client_with_the_apps_own_scopes`.
        let plots = store
            .read(|tx| tx.client_by_id("474e103de61f9141c4b640d59bfa130e"))
            .unwrap()
            .unwrap();
        assert_eq!(
            plots.redirect_uris,
            vec![
                url::Url::parse("https://plots.wildflowerhealth.io/")
                    .expect("a valid absolute redirect"),
                url::Url::parse("https://wildflowerhealth.io/health-viewer/")
                    .expect("a valid absolute redirect"),
            ],
        );
        assert_eq!(
            plots.allowed_grant_types,
            vec![
                AllowedGrantType::AuthorizationCode,
                AllowedGrantType::RefreshToken,
            ],
        );
        // The Synthetic Data Loader carries its published-site redirect, seeded
        // by `0028`. Its write scopes are pinned to
        // `apps/synthetic-data/synthetic-data-web/src/config.ts` by `seeding.rs`'s
        // `seeds_the_synthetic_data_dev_client_with_the_apps_own_scopes`.
        let synthetic_data = store
            .read(|tx| tx.client_by_id("225ba6af034a3acec6be7ff8010df67f"))
            .unwrap()
            .unwrap();
        assert_eq!(synthetic_data.name, "Synthetic Data Loader");
        assert_eq!(
            synthetic_data.redirect_uris,
            vec![
                url::Url::parse("https://synthetic-data.wildflowerhealth.io/")
                    .expect("a valid absolute redirect"),
                url::Url::parse("https://wildflowerhealth.io/synthetic-data/")
                    .expect("a valid absolute redirect"),
            ],
        );
        assert_eq!(
            synthetic_data.allowed_grant_types,
            vec![
                AllowedGrantType::AuthorizationCode,
                AllowedGrantType::RefreshToken,
            ],
        );
    }

    /// Wildflower Authorization's client (`0031`) is a public PKCE client
    /// returning to the app's published root (its own origin, added by `0037`,
    /// and its path on `wildflowerhealth.io`), allowed exactly the scopes the
    /// app asks for (widened by `0041`). Its id and scope string are read out of the app's
    /// `src/config.ts`, the one place the app writes them, so the row can't
    /// drift from it unnoticed: a scope the app asks for that the row doesn't
    /// allow fails `/oauth/authorize`.
    #[test]
    fn migrations_seed_the_authorization_web_client_with_the_apps_own_scopes() {
        const AUTHORIZATION_WEB_CONFIG_TS: &str = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../../apps/authorization/authorization-web/src/config.ts"
        ));
        const AUTHORIZATION_WEB_CLIENT_ID: &str = "7277e898bee8ac81ea44788236e619a5";
        let store = SqliteGrantStore::open_in_memory().expect("open in-memory store");
        let client = store
            .read(|tx| tx.client_by_id(AUTHORIZATION_WEB_CLIENT_ID))
            .expect("query (a decode failure surfaces here)")
            .expect("0031 seeds the Wildflower Authorization client");

        assert!(
            AUTHORIZATION_WEB_CONFIG_TS.contains(&format!("'{AUTHORIZATION_WEB_CLIENT_ID}'")),
            "apps/authorization/authorization-web/src/config.ts must sign in as {AUTHORIZATION_WEB_CLIENT_ID}",
        );
        let scope_string = format!("'{}'", client.allowed_scopes.join(" "));
        assert!(
            AUTHORIZATION_WEB_CONFIG_TS.contains(&scope_string),
            "apps/authorization/authorization-web/src/config.ts must request exactly {scope_string}",
        );
        assert_eq!(client.name, "Wildflower Authorization");
        assert_eq!(client.kind, ClientKind::Public);
        assert!(client.secret_hash.is_none());
        assert_eq!(client.disabled_at, None);
        assert_eq!(
            client.redirect_uris,
            vec![
                url::Url::parse("https://authorization.wildflowerhealth.io/")
                    .expect("a valid absolute redirect"),
                url::Url::parse("https://wildflowerhealth.io/authorization/")
                    .expect("a valid absolute redirect"),
            ],
        );
        assert_eq!(
            client.allowed_scopes,
            vec![
                "openid".to_string(),
                "wildflower/Grant.rd".to_string(),
                "wildflower/Client.ru".to_string(),
                "wildflower/Token.d".to_string(),
                "wildflower/BrowserSession.rd".to_string(),
            ],
        );
        assert_eq!(
            client.allowed_grant_types,
            vec![
                AllowedGrantType::AuthorizationCode,
                AllowedGrantType::RefreshToken,
            ],
        );
    }

    /// The App Catalog publishes each first-party app's OAuth client
    /// registration as its HALO `preassignedCredentials`, for a server that
    /// registers the app itself. Every entry carrying the object must match
    /// its seeded row: a public client with no secret, the same scopes and
    /// grant types, every redirect it lists registered, and a smart-app's
    /// `launchUrl` among them, since its launch page is where it returns to. The row
    /// is the source of truth, so a migration that changes one fails here
    /// until the catalog follows.
    #[test]
    fn app_catalog_preassigns_the_seeded_first_party_clients() {
        const APP_CATALOG_JSON: &str = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../../apps/app-catalog/app-catalog-web/public/apps.json"
        ));
        let catalog: serde_json::Value =
            serde_json::from_str(APP_CATALOG_JSON).expect("apps.json is JSON");
        let store = SqliteGrantStore::open_in_memory().expect("open in-memory store");
        let mut checked = 0;
        for app in catalog.as_array().expect("an array of apps") {
            let Some(credentials) = app.get("preassignedCredentials") else {
                continue;
            };
            let name = app["name"].as_str().expect("a name");
            let client_id = credentials["clientId"].as_str().expect("a clientId");
            let client = store
                .read(|tx| tx.client_by_id(client_id))
                .expect("query (a decode failure surfaces here)")
                .unwrap_or_else(|| panic!("{name}: {client_id} is seeded by a clients migration"));

            assert_eq!(client.kind, ClientKind::Public, "{name}");
            assert!(client.secret_hash.is_none(), "{name}");
            assert_eq!(credentials["tokenEndpointAuthMethod"], "none", "{name}");
            let scopes: Vec<String> =
                serde_json::from_value(app["scopes"].clone()).expect("scopes are strings");
            assert_eq!(scopes, client.allowed_scopes, "{name}: scopes");
            let grant_types: Vec<AllowedGrantType> =
                serde_json::from_value(credentials["grantTypes"].clone()).expect("grant types");
            assert_eq!(
                grant_types, client.allowed_grant_types,
                "{name}: grantTypes"
            );
            for redirect in credentials["redirectUris"]
                .as_array()
                .expect("redirectUris")
            {
                let redirect = url::Url::parse(redirect.as_str().expect("a string"))
                    .expect("an absolute redirect");
                assert!(
                    client.redirect_uris.contains(&redirect),
                    "{name}: {redirect} is not registered for {client_id}",
                );
            }
            if let Some(launch_url) = app.get("launchUrl") {
                let launch_url = url::Url::parse(launch_url.as_str().expect("a string"))
                    .expect("an absolute launch URL");
                assert!(
                    client.redirect_uris.contains(&launch_url),
                    "{name}: its launchUrl {launch_url} is not registered for {client_id}",
                );
            }
            checked += 1;
        }
        assert!(checked > 0, "apps.json preassigns no first-party client");
    }

    /// The launcher's client (`0012`, narrowed by `0032`) allows exactly the
    /// scopes the launcher asks for. The scope string is read out of the app's
    /// `src/sign-in.ts`, the one place the app writes it: the client is trusted
    /// on first use, so the request is what bounds it, and a row wider than the
    /// request would be a ceiling nothing uses.
    #[test]
    fn migrations_narrow_the_launcher_client_to_the_apps_own_scopes() {
        const LAUNCHER_SIGN_IN_TS: &str = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../../apps/launcher/launcher-web/src/sign-in.ts"
        ));
        const LAUNCHER_CLIENT_ID: &str = "03a513940b52f8c2649a5366d1a26d19";
        let store = SqliteGrantStore::open_in_memory().expect("open in-memory store");
        let client = store
            .read(|tx| tx.client_by_id(LAUNCHER_CLIENT_ID))
            .expect("query (a decode failure surfaces here)")
            .expect("0012 seeds the launcher client");

        assert!(
            LAUNCHER_SIGN_IN_TS.contains(&format!("'{LAUNCHER_CLIENT_ID}'")),
            "apps/launcher/launcher-web/src/sign-in.ts must sign in as {LAUNCHER_CLIENT_ID}",
        );
        let scope_string = format!(
            "const LAUNCHER_SCOPE = '{}'",
            client.allowed_scopes.join(" ")
        );
        assert!(
            LAUNCHER_SIGN_IN_TS.contains(&scope_string),
            "apps/launcher/launcher-web/src/sign-in.ts must declare exactly {scope_string}",
        );
        assert_eq!(
            client.allowed_scopes,
            vec![
                "launch".to_string(),
                "launch/patient".to_string(),
                "wildflower/launch".to_string(),
                "system/*.cruds".to_string(),
                "wildflower/*.cruds".to_string(),
            ],
        );
    }

    /// Each of the client row's custom column mappings rejects an out-of-domain
    /// stored value on read as a typed diesel error, never a panic: the JSON TEXT
    /// newtypes ([`JsonUrls`](super::JsonUrls) / [`JsonStrings`](crate::db::shared::JsonStrings)
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
            ("redirect_uris", "not json"),        // JsonUrls: malformed JSON
            ("redirect_uris", "[\"not a url\"]"), // JsonUrls: valid JSON, not a URL
            // JsonUrls: a path entry is not an absolute URL (why migration 0021
            // strips them)
            ("redirect_uris", "[\"/\"]"),
            ("allowed_scopes", "not json"), // JsonStrings: malformed JSON
            ("allowed_grant_types", "[\"totally_unknown\"]"), // JsonAllowedGrantTypes: unknown member
            ("kind", "bogus_kind"),                           // ClientKind: unknown discriminant
        ] {
            let store = SqliteGrantStore::open_in_memory().expect("open in-memory store");
            let mut conn = store.pool().get().expect("check out a connection");
            diesel::sql_query(format!(
                "UPDATE clients SET {column} = '{bad_value}' WHERE client_id = 'growth_chart'"
            ))
            .execute(&mut conn)
            .expect("tamper the stored row");
            drop(conn);
            assert!(
                store.read(|tx| tx.client_by_id("growth_chart")).is_err(),
                "a corrupt `{column}` must surface as a typed read error",
            );
        }
    }
}
