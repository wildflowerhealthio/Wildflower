-- Drop the table `0001_initial_schema` created. A server's relay settings and
-- public host live in its record in `servers.json`, which the host hands the
-- tunnel when the server starts; no rows are carried over.
DROP TABLE tunnel_settings;
