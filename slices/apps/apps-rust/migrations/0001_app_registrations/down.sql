-- Reverse of up.sql. Configurations first (though `ON DELETE CASCADE` + the drop
-- order make it moot), then the parent registrations.
DROP TABLE IF EXISTS system_app_configurations;
DROP TABLE IF EXISTS cloud_app_configurations;
DROP TABLE IF EXISTS self_hosted_app_configurations;
DROP TABLE IF EXISTS app_registrations;
