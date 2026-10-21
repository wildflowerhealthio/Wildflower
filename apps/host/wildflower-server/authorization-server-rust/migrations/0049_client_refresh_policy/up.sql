-- Each client's refresh policy: how long its refresh-token families last once
-- it has signed in. Read on every refresh, so an existing family picks its
-- client's policy up on its next refresh.
--
--   refresh_idle_ttl_seconds           a family ends if nothing refreshes it
--                                      for this long; NULL for no idle limit
--   refresh_max_ttl_seconds            a family ends this long after it was
--                                      issued; NULL for only the 365-day ceiling
--   refresh_ends_with_browser_session  1 if a family ends when the browser
--                                      session it was minted under expires
ALTER TABLE clients ADD COLUMN refresh_idle_ttl_seconds INTEGER;
ALTER TABLE clients ADD COLUMN refresh_max_ttl_seconds INTEGER;
ALTER TABLE clients ADD COLUMN refresh_ends_with_browser_session INTEGER NOT NULL DEFAULT 0;

-- Every client starts with the policy a client trusted on first use is given
-- at registration (`RefreshPolicy::trusted_on_first_use`): any `wildflower/`
-- scope ties it to its browser session with a two-hour idle limit; otherwise
-- a day idle and a week at most. The rows named below are then overwritten;
-- this leaves the clients the Owner approved and the SMART sample apps.
UPDATE clients
   SET refresh_idle_ttl_seconds = 7200,
       refresh_max_ttl_seconds = NULL,
       refresh_ends_with_browser_session = 1
 WHERE EXISTS (SELECT 1 FROM json_each(clients.allowed_scopes)
                WHERE substr(json_each.value, 1, 11) = 'wildflower/');
UPDATE clients
   SET refresh_idle_ttl_seconds = 86400,
       refresh_max_ttl_seconds = 604800,
       refresh_ends_with_browser_session = 0
 WHERE NOT EXISTS (SELECT 1 FROM json_each(clients.allowed_scopes)
                    WHERE substr(json_each.value, 1, 11) = 'wildflower/');

-- Wildflower Authorization: ends with the browser session, 30 minutes idle.
UPDATE clients
   SET refresh_idle_ttl_seconds = 1800,
       refresh_max_ttl_seconds = NULL,
       refresh_ends_with_browser_session = 1
 WHERE client_id = '7277e898bee8ac81ea44788236e619a5';

-- The Launcher, the Server API Console (server-docs) and the FHIR server UI:
-- end with the browser session, two hours idle. The FHIR server UI's id is
-- `FHIR_UI_CLIENT_ID` in `wildflower-server-rust`; seeding inserts its row
-- with this policy on an install that has none yet.
UPDATE clients
   SET refresh_idle_ttl_seconds = 7200,
       refresh_max_ttl_seconds = NULL,
       refresh_ends_with_browser_session = 1
 WHERE client_id IN (
         '03a513940b52f8c2649a5366d1a26d19',
         '664a01e8614050cd82ffe90350b81413',
         '5ea43272eba5e825c50de39032f96bf0'
       );

-- The data apps and their dev twins: Medications, Plots, Strength, Importer,
-- Synthetic Data and the OHIF viewer. A week idle, 30 days at most,
-- outliving the browser session.
UPDATE clients
   SET refresh_idle_ttl_seconds = 604800,
       refresh_max_ttl_seconds = 2592000,
       refresh_ends_with_browser_session = 0
 WHERE client_id IN (
         '9769f8b274370708d0d3ebb2e3e59b7c', '4be2ee91360733fdcb99b43a3822de5f',
         '474e103de61f9141c4b640d59bfa130e', 'e7efc7c805f5f8f640bb3b3d48a2d7aa',
         'bdf9fc5cb5a28c6683b49896b0ef8a75', '8467e680a05f1e92e22864e923144e5a',
         '165cd26573e5ac72378e6ad2d2198330', '57268ff88aea38d6a22de56ae53e2c28',
         '225ba6af034a3acec6be7ff8010df67f', '07a31e58db3367afda5c6480e03ed993',
         '941de68e6b59eb9dcc32df8ede89e636', 'f9866f7b1d0d8505dc65ef4f749664b5'
       );

-- FHIR Sync for Pebble and its dev twin: it only writes and nobody watches
-- it, so 30 days idle and 365 days at most.
UPDATE clients
   SET refresh_idle_ttl_seconds = 2592000,
       refresh_max_ttl_seconds = 31536000,
       refresh_ends_with_browser_session = 0
 WHERE client_id IN ('6847df97d54c31936d54ca1b36b3bb09', '61e195d6b08bab6bf2cedb1ef3831fa7');

-- The host app's client: a paired device, tied to no browser session and
-- with no idle limit, so only the ceiling ends its families.
UPDATE clients
   SET refresh_idle_ttl_seconds = NULL,
       refresh_max_ttl_seconds = NULL,
       refresh_ends_with_browser_session = 0
 WHERE client_id = 'c4e755b6a4c1abf2aae6d0d83f2545a5';

-- The browser-session client: its tokens are never refreshed, so its policy
-- only says nothing it holds outlives the browser session.
UPDATE clients
   SET refresh_idle_ttl_seconds = NULL,
       refresh_max_ttl_seconds = NULL,
       refresh_ends_with_browser_session = 1
 WHERE client_id = 'cb9bbe139845cae9654b7909d60d274f';
