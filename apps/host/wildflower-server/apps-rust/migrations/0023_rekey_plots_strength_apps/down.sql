-- Restore the Health Viewer's and Lifting's `0019` / `0017` ids, and their
-- seeded names where the row still holds the one `up.sql` wrote (see up.sql).
UPDATE app_registrations
   SET id = 'health-viewer',
       name = CASE name WHEN 'Plots' THEN 'Synthesized Health Viewer' ELSE name END
 WHERE id = 'plots';

UPDATE app_registrations
   SET id = 'health-viewer-dev',
       name = CASE name WHEN 'Plots (Dev)' THEN 'Health Viewer (Dev)' ELSE name END
 WHERE id = 'plots-dev';

UPDATE app_registrations
   SET id = 'lifting',
       name = CASE name WHEN 'Strength' THEN 'Lifting' ELSE name END
 WHERE id = 'strength';

UPDATE app_registrations
   SET id = 'lifting-dev',
       name = CASE name WHEN 'Strength (Dev)' THEN 'Lifting (Dev)' ELSE name END
 WHERE id = 'strength-dev';
