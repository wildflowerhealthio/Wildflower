-- Seed the PRECISE-HBR Risk Calculator as a default external app. Lands as its
-- own run-once migration per the convention documented in 001: only installs
-- that have not yet applied this version get the row, and a user who later
-- edits or deletes it keeps that choice (INSERT OR IGNORE + run-once).
INSERT OR IGNORE INTO apps (id, enabled, name, subtitle, url, requires_tunnel) VALUES
    (
        'precise-hbr',
        1,
        'PRECISE-HBR Risk Calculator',
        'Assess risk of major bleeding after percutaneous coronary intervention',
        'https://hbr.alumicoin.cloud/launch?iss={origin}/fhir-r4&launch={launch}',
        1
    );
