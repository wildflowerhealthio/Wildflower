-- Reverse of up.sql. Children first (though `ON DELETE CASCADE` + the drop order
-- make it moot), then the parent registry.
DROP TABLE IF EXISTS system_apps;
DROP TABLE IF EXISTS cloud_apps;
DROP TABLE IF EXISTS self_hosted_apps;
DROP TABLE IF EXISTS app_registry;
