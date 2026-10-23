-- Access codes issued through the admin API (`POST /api/access-codes`): each
-- redeems once, at `POST /access`, for a new tunnel under the email and
-- subdomain the redeemer chooses. Unlike a claim code, an access code names
-- no tunnel. `code_hash` is the SHA-256 of the code's eight characters
-- (uppercase, without the dash), as for a claim code, and no hash is stored
-- in both tables: the store checks the other table before writing either.
-- The code itself is never stored. `expires_at` is Unix epoch seconds: the
-- code redeems while the relay's clock reads earlier.
CREATE TABLE access_codes (
    code_hash BLOB PRIMARY KEY NOT NULL,
    expires_at INTEGER NOT NULL
) STRICT;
