-- Reverse of up.sql.
UPDATE clients
   SET allowed_scopes = '["openid","profile","fhirUser","launch","launch/patient","offline_access","wildflower/launch","system/*.cruds","wildflower/*.cruds"]'
 WHERE client_id = '03a513940b52f8c2649a5366d1a26d19'
   AND allowed_scopes = '["launch","launch/patient","wildflower/launch","system/*.cruds","wildflower/*.cruds"]';
