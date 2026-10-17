-- Rename the Strength tile, and a debug build's dev tile, to the product's
-- name, Wildflower Strength. The ids (`strength`, `strength-dev`), clients and
-- launch URLs stay.
--
-- In place, so a user's placement (`position`, `on_homescreen`) is kept. The
-- display name moves only while it is still the one its seed wrote (`0023`'s
-- "Strength", the dev seed's "Strength (Dev)"): a name the user edited is
-- theirs, as in `0023`. A debug build's dev seed (`apps-rust/src/dev_seed.rs`)
-- reconciles the dev tile's name on the next boot anyway; renaming it here
-- keeps a database a release build opens consistent.
UPDATE app_registrations
   SET name = CASE name WHEN 'Strength' THEN 'Wildflower Strength' ELSE name END
 WHERE id = 'strength';

UPDATE app_registrations
   SET name = CASE name WHEN 'Strength (Dev)' THEN 'Wildflower Strength (Dev)' ELSE name END
 WHERE id = 'strength-dev';
