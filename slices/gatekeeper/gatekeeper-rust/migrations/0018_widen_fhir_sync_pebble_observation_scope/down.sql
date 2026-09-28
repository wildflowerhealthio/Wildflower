UPDATE clients
   SET allowed_scopes = '["openid","fhirUser","system/Patient.rs","system/Observation.c"]'
 WHERE client_id = 'fhir-sync-pebble'
   AND allowed_scopes = '["openid","fhirUser","system/Patient.rs","system/Observation.cu"]';
