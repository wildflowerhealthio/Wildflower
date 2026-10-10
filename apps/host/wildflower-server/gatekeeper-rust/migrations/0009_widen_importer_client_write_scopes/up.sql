-- Widen the Importer SMART app client's scope set: add `Practitioner`,
-- `DiagnosticReport`, `Medication`, `MedicationRequest`, `MedicationDispense`,
-- `ServiceRequest`, and `ImagingStudy`, and broaden every FHIR resource type to
-- full `.cruds` (create + read + update + delete + search), replacing the
-- tightened `.rs` / `.u` letters `0008_seed_wildflower_importer_client` shipped.
--
-- This is a NEW migration rather than an edit to `0008` because migrations are
-- run-once and never re-applied: an install that already ran `0008` would never
-- see a changed `0008`. And it must `UPDATE` rather than `INSERT`, because `0008`
-- inserted the `importer-app` row already — its `INSERT OR IGNORE` would no-op
-- against the existing PK, so re-inserting here would silently NOT widen the set.
--
-- `.cruds` on each resource type (not `0008`'s per-interaction letters): the
-- importer client may create, read, update, delete, and search every type it
-- handles. `DocumentReference`'s two `0008` entries (`.rs` + `.u`) collapse into
-- one `.cruds`. `system/` (not `patient/`) for the same reason as before: a HAR
-- archive carries no `subject`, so a `patient/` scope would match nothing.
--
-- This array MUST stay element-for-element equal to the space-separated `scope`
-- string in `apps/importer-web/src/config.ts` (both `smartConfig` and
-- `standaloneSmartConfig`) — a scope the app requests but this client is not
-- allowed fails `/authorize`. Nothing spans the TS/Rust boundary to check it, so
-- the pairing is held by mirrors: that file's doc comment, this comment,
-- `apps/importer-web/AGENTS.md`, and the exact vector asserted in
-- `db/clients.rs`'s `migrations_seed_the_smart_app_clients`. The debug-only
-- `importer-app-dev` client (`seeding.rs`'s `seed_dev_app_clients`) carries this
-- same set — widen it in step too.
UPDATE clients
SET allowed_scopes = '["launch","openid","fhirUser","system/DocumentReference.cruds","system/Patient.cruds","system/Observation.cruds","system/Practitioner.cruds","system/DiagnosticReport.cruds","system/Medication.cruds","system/MedicationRequest.cruds","system/MedicationDispense.cruds","system/ServiceRequest.cruds","system/ImagingStudy.cruds"]'
WHERE client_id = 'importer-app';
