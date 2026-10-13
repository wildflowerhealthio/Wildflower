-- Re-apply `0009_widen_importer_client_write_scopes` on any install that never
-- ran it.
--
-- WHY THIS EXISTS. Two migrations share the prefix `0009`:
-- `0009_seed_ohif_viewer_client` and `0009_widen_importer_client_write_scopes`.
-- The runner keys applied migrations by the directory prefix before the first
-- `_` (the diesel version), so the two are ONE version to it. A fresh database
-- runs both, but an install that opened with only the OHIF seed present (it
-- landed a day before the importer widening) recorded `0009` as applied and so
-- skips the widening forever. Such an install keeps the `.rs` / `.u` set `0008`
-- seeded, and every Importer launch that requests a `.cruds` scope is refused
-- at `/authorize`.
--
-- Both `0009` directories are left exactly as they shipped: renaming or
-- removing one changes nothing for an install that already recorded `0009`,
-- and a fresh install still needs both. This migration and
-- `0016_repair_ohif_viewer_client` carry each one's end state under a unique
-- version instead, so every install is certain to have both.
--
-- IDEMPOTENT. The `UPDATE` only fires while the row still holds the exact set
-- `0008` seeded — the one state the skipped widening leaves behind. An install
-- that ran the widening already matches nothing, and so does a row whose
-- scopes were deliberately changed since, which this repair must not
-- overwrite.
--
-- The widened array is `0009`'s verbatim: it brings a lagging install level
-- with `0009`, not with whatever `apps/importer-web/src/config.ts` requests
-- later. A future scope change is a new migration of its own.
UPDATE clients
   SET allowed_scopes = '["launch","openid","fhirUser","system/DocumentReference.cruds","system/Patient.cruds","system/Observation.cruds","system/Practitioner.cruds","system/DiagnosticReport.cruds","system/Medication.cruds","system/MedicationRequest.cruds","system/MedicationDispense.cruds","system/ServiceRequest.cruds","system/ImagingStudy.cruds"]'
 WHERE client_id = 'importer-app'
   AND allowed_scopes = '["launch","openid","fhirUser","system/DocumentReference.rs","system/DocumentReference.u","system/Patient.u","system/Observation.u"]';
