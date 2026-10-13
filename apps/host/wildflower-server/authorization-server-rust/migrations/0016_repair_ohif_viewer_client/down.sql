-- Irreversible by design, like `0011_repair_first_party_app_clients`. This
-- migration cannot tell a row it created from one `0009_seed_ohif_viewer_client`
-- seeded, and deleting the latter would unregister a working client. Down is a
-- deliberate no-op.
SELECT 1;
