-- Re-key the Health Viewer and Lifting tiles to their products' names, as
-- `0017` and `0019` did for the apps before them. The apps live in
-- `apps/plots/` and `apps/strength/`, so their tile ids are `plots` (was
-- `health-viewer`) and `strength` (was `lifting`), and a debug build's dev
-- tiles `plots-dev` and `strength-dev`. Their OAuth clients already have random
-- ids (`0017`, `0019`), so `client_id` stays, and nothing in
-- authorization-server-rust's `clients` changes.
--
-- In place, so a user's placement (`position`, `on_homescreen`) is kept. The
-- launch URLs stay: the apps are still published at
-- <https://wildflowerhealth.io/health-viewer/> and
-- <https://wildflowerhealth.io/lifting/>, and the dev rows' URLs name a
-- loopback port, which the dev seed (`apps-rust/src/dev_seed.rs`) recognizes
-- under the new ids.
--
-- The display name moves only while it is still the one its seed wrote
-- (`0015`'s "Synthesized Health Viewer", `0010`'s "Lifting", the dev seed's
-- "… (Dev)"): a name the user edited is theirs, as a launch URL is in `0016`.
UPDATE app_registrations
   SET id = 'plots',
       name = CASE name WHEN 'Synthesized Health Viewer' THEN 'Plots' ELSE name END
 WHERE id = 'health-viewer';

UPDATE app_registrations
   SET id = 'plots-dev',
       name = CASE name WHEN 'Health Viewer (Dev)' THEN 'Plots (Dev)' ELSE name END
 WHERE id = 'health-viewer-dev';

UPDATE app_registrations
   SET id = 'strength',
       name = CASE name WHEN 'Lifting' THEN 'Strength' ELSE name END
 WHERE id = 'lifting';

UPDATE app_registrations
   SET id = 'strength-dev',
       name = CASE name WHEN 'Lifting (Dev)' THEN 'Strength (Dev)' ELSE name END
 WHERE id = 'lifting-dev';
