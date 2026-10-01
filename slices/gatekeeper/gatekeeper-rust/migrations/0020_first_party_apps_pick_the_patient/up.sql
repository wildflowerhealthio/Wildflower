-- The first-party Medications and Lifting apps pick the patient in the app:
-- their clients stop allowing `launch/patient`, and Medications' gains
-- `system/Patient.rs` for the picker's `Patient` reads.
--
-- Each app asks for `system/` scopes only and offers a patient picker after
-- sign-in (`smart-app-react`'s `PatientPicker`), with an "All patients" choice
-- that reads unscoped. An EHR launch that carries a patient opens on that
-- patient, and the reader can still change it. So the consent screen binds no
-- patient to the token, and nothing requests `launch/patient`.
--
--   * `medications-app` (seeded by `0004`, repaired by `0011`): `launch/patient`
--     out, `system/Patient.rs` in — the picker searches `Patient`, and the line
--     under the title reads the one chosen.
--   * `lifting-app` (seeded by `0019`): `launch/patient` out; it already reads
--     `Patient`.
--
-- Each array MUST equal the scope string its app requests, element for element
-- and in the same order: `MEDICATIONS_SCOPE` in
-- `apps/medications-app/src/config.ts` and `LIFTING_SCOPE` in
-- `apps/lifting-app/src/config.ts`. `seeding.rs`'s
-- `seeds_the_medications_dev_client_with_the_apps_own_scopes` and
-- `seeds_the_lifting_dev_client_with_the_apps_own_scopes` read those files and
-- pin both this migration's clients and the debug-only `-dev` clients to them.
--
-- IDEMPOTENT. Each `UPDATE` only fires while the row still holds the exact set
-- its seed wrote, so a row whose scopes were deliberately changed since is left
-- alone.
UPDATE clients
   SET allowed_scopes = '["launch","openid","fhirUser","system/MedicationRequest.rs","system/Medication.rs","system/Patient.rs"]'
 WHERE client_id = 'medications-app'
   AND allowed_scopes = '["launch","launch/patient","openid","fhirUser","system/MedicationRequest.rs","system/Medication.rs"]';

UPDATE clients
   SET allowed_scopes = '["launch","openid","fhirUser","system/Patient.rs","system/PlanDefinition.crus","system/ServiceRequest.crus","system/Procedure.crus","system/Observation.crus"]'
 WHERE client_id = 'lifting-app'
   AND allowed_scopes = '["launch","launch/patient","openid","fhirUser","system/Patient.rs","system/PlanDefinition.crus","system/ServiceRequest.crus","system/Procedure.crus","system/Observation.crus"]';
