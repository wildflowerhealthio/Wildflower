-- Restore the seeded names `0019`, `0022` and the dev seed wrote, where the
-- client still holds the one `up.sql` wrote (see up.sql).
UPDATE clients
   SET name = CASE name WHEN 'Plots' THEN 'Synthesized Health Viewer' ELSE name END
 WHERE client_id = '474e103de61f9141c4b640d59bfa130e';

UPDATE clients
   SET name = CASE name WHEN 'Plots (Dev)' THEN 'Health Viewer (Dev)' ELSE name END
 WHERE client_id = 'e7efc7c805f5f8f640bb3b3d48a2d7aa';

UPDATE clients
   SET name = CASE name WHEN 'Strength' THEN 'Lifting' ELSE name END
 WHERE client_id = 'bdf9fc5cb5a28c6683b49896b0ef8a75';

UPDATE clients
   SET name = CASE name WHEN 'Strength (Dev)' THEN 'Lifting (Dev)' ELSE name END
 WHERE client_id = '8467e680a05f1e92e22864e923144e5a';
