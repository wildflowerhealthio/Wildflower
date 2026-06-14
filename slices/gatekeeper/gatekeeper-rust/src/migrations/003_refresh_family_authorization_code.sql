-- Link a refresh-token family back to the authorization code that minted it
-- (RFC 6749 §4.1.2 / OAuth 2.1 §4.1.2.1). When a consumed authorization code is
-- detectably replayed at /token, the family produced by its first redemption is
-- a theft signal and must be revoked. We store the SHA-256 base64url *hash* of
-- the code (never the plaintext), matching how refresh tokens are kept. Null for
-- families minted by flows that carry no authorization code (the device-code
-- grant), which has its own single-use enforcement.
ALTER TABLE refresh_token_families ADD COLUMN authorization_code_hash TEXT;

CREATE INDEX refresh_token_families_authorization_code_hash_idx
    ON refresh_token_families(authorization_code_hash);
