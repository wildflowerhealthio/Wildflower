-- Restore Lifting's `0010` ids and published path (see up.sql).
UPDATE app_registrations
   SET id = 'lifting-app',
       client_id = 'lifting-app',
       url = replace(url,
                     'https://wildflowerhealth.io/lifting/',
                     'https://wildflowerhealth.io/lifting-app/')
 WHERE id = 'lifting';

UPDATE app_registrations
   SET id = 'lifting-app-dev',
       client_id = 'lifting-app-dev'
 WHERE id = 'lifting-dev';
