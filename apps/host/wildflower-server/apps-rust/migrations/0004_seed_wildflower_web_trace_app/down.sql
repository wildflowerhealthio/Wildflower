-- Reverse of up.sql. Delete the configuration row first, then the registration
-- (explicit rather than relying on ON DELETE CASCADE, so it is correct whether
-- or not the connection has foreign-key enforcement enabled).
DELETE FROM self_hosted_app_configurations WHERE id = 'wildflower-web-trace';
DELETE FROM app_registrations WHERE id = 'wildflower-web-trace';
