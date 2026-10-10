-- Remove the Web Trace app. `apps/web-trace` is deleted and no longer published
-- at <https://wildflowerhealth.io/web-trace-app/>, so its tile launches nothing.
-- The gatekeeper half, which deletes its OAuth clients, is gatekeeper migration
-- `0027_remove_web_trace_clients`.
--
-- The debug-only `web-trace-app-dev` row goes too, but only when it is the dev
-- seed's own (it carries the seed's `client_id`): the seed leaves a user's row
-- that happens to share the id alone, and so does this.
--
-- `position` is renumbered to a dense `0..n` in its existing order, as in
-- `0014_remove_origin_relative_apps`.

DELETE FROM app_registrations
 WHERE id = 'web-trace-app'
    OR (id = 'web-trace-app-dev' AND client_id = 'web-trace-app-dev');

UPDATE app_registrations SET position = -1 - position;

UPDATE app_registrations
   SET position = ranked.rank
  FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY position DESC) - 1 AS rank
          FROM app_registrations) AS ranked
 WHERE ranked.id = app_registrations.id;
