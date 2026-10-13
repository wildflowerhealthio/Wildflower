-- Irreversible by design, like `0011_repair_first_party_app_clients`. This
-- migration only brings a row to the state `0009_widen_importer_client_write_scopes`
-- already intends, and it cannot tell a row it widened from one that was
-- widened by `0009` itself. Down is a deliberate no-op.
SELECT 1;
