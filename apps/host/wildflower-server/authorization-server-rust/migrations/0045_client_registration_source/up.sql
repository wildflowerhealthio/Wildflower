-- Who defines a client's registration: `server_defined` for the clients
-- boot-time seeding owns (the host app's, the browser-session client and the
-- FHIR server UI's), which a request is held to and an approval never widens;
-- `trusted_on_first_use` for every other client, whose registration the
-- Owner's approvals create and widen. Every existing row starts trusted on
-- first use: the host app's and the FHIR server UI's client ids are
-- configuration, so seeding's upsert marks the three server-defined rows on
-- every boot, before the server serves a request.
ALTER TABLE clients ADD COLUMN registration_source TEXT NOT NULL DEFAULT 'trusted_on_first_use';
