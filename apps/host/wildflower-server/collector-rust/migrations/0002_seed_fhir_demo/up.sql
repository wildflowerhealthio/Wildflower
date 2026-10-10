-- Seed the demo FHIR remote the retired api_stubs stub used to hardcode, so a
-- fresh install keeps today's behavior (the browser-sniffer flow has something
-- to drive against). `added_at` is pinned to the static demo-install date the
-- stub shipped with: generating it at migration time would let the SPA render
-- "added X minutes ago" for an entry that's always existed. Run-once semantics
-- mean a user who deletes this row keeps it deleted across upgrades — only
-- fresh installs see it.
INSERT INTO collector_remotes (id, name, tag, config, added_at) VALUES (
    'fhir-demo',
    'FHIR Demo',
    'fhir-r4',
    '{"_tag":"fhir-r4","rootUrl":"https://r4.smarthealthit.org","patientId":"8c0f46f4-dd7b-4a5f-bd35-f0f41a2f8882"}',
    '2026-06-17T14:29:22.363Z'
);
