ALTER TABLE authorization_requests ADD COLUMN code_challenge_method TEXT;

UPDATE authorization_requests
   SET code_challenge_method = 'S256'
 WHERE code_challenge IS NOT NULL;

UPDATE authorization_requests
   SET status = 'expired'
 WHERE status = 'claimed';
