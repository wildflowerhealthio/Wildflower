-- Reverse of up.sql.
UPDATE clients
   SET allowed_scopes = '["launch","launch/patient","openid","fhirUser","system/MedicationRequest.rs","system/Medication.rs"]'
 WHERE client_id = 'medications-app'
   AND allowed_scopes = '["launch","openid","fhirUser","system/MedicationRequest.rs","system/Medication.rs","system/Patient.rs"]';

UPDATE clients
   SET allowed_scopes = '["launch","launch/patient","openid","fhirUser","system/Patient.rs","system/PlanDefinition.crus","system/ServiceRequest.crus","system/Procedure.crus","system/Observation.crus"]'
 WHERE client_id = 'lifting-app'
   AND allowed_scopes = '["launch","openid","fhirUser","system/Patient.rs","system/PlanDefinition.crus","system/ServiceRequest.crus","system/Procedure.crus","system/Observation.crus"]';
