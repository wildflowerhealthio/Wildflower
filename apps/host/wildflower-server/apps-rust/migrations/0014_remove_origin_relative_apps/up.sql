-- Every `app_registrations.url` is an absolute `http://` or `https://` launch
-- template: an app is served from its own origin, never the host's. Delete
-- every app whose template is anything else — an origin-relative `/path` or a
-- leading `{origin}`, either of which resolves against the host's own origin.
--
-- No seeded row has that shape (the system apps 0012 deleted were the only
-- ones), but `POST /apps` accepted it, so a user-created row can. The
-- `AppRegistration` row decodes its `url` as an absolute URL, so such a row
-- would fail to load and take every registry read down with it. No soft
-- reference needs cleaning up: a created app carries no `client_id`.
--
-- `GLOB` (case-sensitive, unlike `LIKE`) matches exactly the prefixes the
-- decoder accepts.
--
-- `position` is renumbered to a dense `0..n` in its existing order, so the gap
-- the deleted rows leave doesn't survive. SQLite checks UNIQUE per row, so the
-- rows first move to a disjoint negative range (as `PUT /home-screen` does),
-- then take their rank, read from a window over that range.

DELETE FROM app_registrations
 WHERE url NOT GLOB 'http://*' AND url NOT GLOB 'https://*';

UPDATE app_registrations SET position = -1 - position;

UPDATE app_registrations
   SET position = ranked.rank
  FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY position DESC) - 1 AS rank
          FROM app_registrations) AS ranked
 WHERE ranked.id = app_registrations.id;
