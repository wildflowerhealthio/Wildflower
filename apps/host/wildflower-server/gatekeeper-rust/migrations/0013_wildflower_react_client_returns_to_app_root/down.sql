-- Reverse of up.sql: back to the single `/app/home` entry 0012 seeded. Redirects
-- registered on first use after up.sql ran are dropped with it.
UPDATE clients
   SET redirect_uris = '["https://wildflowerhealth.io/app/home"]'
 WHERE client_id = 'wildflower-react';
