-- HISTORICAL run-once migration (see 002's header). Seeds PRECISE-HBR into the
-- flat `apps` table that migration 004 then DROPs and re-seeds into the registry,
-- so this only matters for a database that applied 001..003 before 004 shipped.
-- Run-once + INSERT OR IGNORE per the convention documented in 001. Do not delete.
INSERT OR IGNORE INTO apps (id, enabled, name, subtitle, url, requires_tunnel) VALUES
    (
        'precise-hbr',
        1,
        'PRECISE-HBR Risk Calculator',
        'Assess risk of major bleeding after percutaneous coronary intervention',
        'https://hbr.alumicoin.cloud/launch?iss={origin}/fhir-r4&launch={launch}',
        1
    );
