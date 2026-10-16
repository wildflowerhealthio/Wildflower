-- Rename the Synthesized Health Viewer's and Lifting's OAuth clients to their
-- products' names, Plots and Strength: a client's name is what the consent
-- request and the Owner's list of clients show. Each client is keyed by the
-- random id `0028` / `0025` gave it:
--
--   474e103de61f9141c4b640d59bfa130e  "Synthesized Health Viewer" -> "Plots"
--   e7efc7c805f5f8f640bb3b3d48a2d7aa  "Health Viewer (Dev)"       -> "Plots (Dev)"
--   bdf9fc5cb5a28c6683b49896b0ef8a75  "Lifting"                   -> "Strength"
--   8467e680a05f1e92e22864e923144e5a  "Lifting (Dev)"             -> "Strength (Dev)"
--
-- A debug build's dev clients are upserted under their new names by
-- `seed_dev_app_clients` on the next boot anyway; renaming them here keeps a
-- database a release build opens consistent.
--
-- The name moves only while it is still the one its seed wrote (`0022`'s
-- "Synthesized Health Viewer", `0019`'s "Lifting", the dev seed's "… (Dev)"),
-- as the tiles' names do in apps migration `0023_rekey_plots_strength_apps`:
-- a name something else wrote is left as it is.
UPDATE clients
   SET name = CASE name WHEN 'Synthesized Health Viewer' THEN 'Plots' ELSE name END
 WHERE client_id = '474e103de61f9141c4b640d59bfa130e';

UPDATE clients
   SET name = CASE name WHEN 'Health Viewer (Dev)' THEN 'Plots (Dev)' ELSE name END
 WHERE client_id = 'e7efc7c805f5f8f640bb3b3d48a2d7aa';

UPDATE clients
   SET name = CASE name WHEN 'Lifting' THEN 'Strength' ELSE name END
 WHERE client_id = 'bdf9fc5cb5a28c6683b49896b0ef8a75';

UPDATE clients
   SET name = CASE name WHEN 'Lifting (Dev)' THEN 'Strength (Dev)' ELSE name END
 WHERE client_id = '8467e680a05f1e92e22864e923144e5a';
