-- Rename Strength's OAuth clients to the product's name, Wildflower Strength:
-- a client's name is what the consent request and the Owner's list of clients
-- show. Each client is keyed by the random id `0025` gave it:
--
--   bdf9fc5cb5a28c6683b49896b0ef8a75  "Strength"       -> "Wildflower Strength"
--   8467e680a05f1e92e22864e923144e5a  "Strength (Dev)" -> "Wildflower Strength (Dev)"
--
-- A debug build's dev client is upserted under its new name by
-- `seed_dev_app_clients` on the next boot anyway; renaming it here keeps a
-- database a release build opens consistent.
--
-- The name moves only while it is still the one `0035` wrote, as the tiles'
-- names do in apps migration `0025_rename_strength_app`: a name something else
-- wrote is left as it is.
UPDATE clients
   SET name = CASE name WHEN 'Strength' THEN 'Wildflower Strength' ELSE name END
 WHERE client_id = 'bdf9fc5cb5a28c6683b49896b0ef8a75';

UPDATE clients
   SET name = CASE name WHEN 'Strength (Dev)' THEN 'Wildflower Strength (Dev)' ELSE name END
 WHERE client_id = '8467e680a05f1e92e22864e923144e5a';
