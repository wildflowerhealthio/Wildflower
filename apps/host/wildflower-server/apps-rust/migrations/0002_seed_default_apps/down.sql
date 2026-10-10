-- Reverse of up.sql: remove the seeded default rows. Deleting the registrations
-- cascades to their configuration rows (`ON DELETE CASCADE`), so the registration
-- delete alone suffices.
DELETE FROM app_registrations WHERE id IN (
    'patient-browser',
    'api-view',
    'api-docs',
    'growth-chart',
    'medication-viewer',
    'precise-hbr'
);
