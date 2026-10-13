-- Every `clients.redirect_uris` entry is an absolute URL, matched by exact
-- equality at `/authorize`. Strip any entry that is a path (a string starting
-- with `/`) from every client's allowlist.
--
-- The seeded first-party clients carry a `"/"` entry from their seeds and
-- repairs (`medications-app`, `web-trace-app`, `importer-app`, `ohif-viewer`,
-- `lifting-app`, ...). The `Client` row decodes each entry as an absolute
-- `url::Url`, so a row still holding a path would fail to load at all.
--
-- ORDER-PRESERVING. The remaining entries are rebuilt in their original array
-- order (`json_each`'s `key` is the array index), so a row keeps its absolute
-- entries exactly as it listed them.
--
-- IDEMPOTENT. Only a row that actually holds a path entry is rewritten; a row
-- that holds none — including every row once this has run — is left untouched.
UPDATE clients
   SET redirect_uris = (
       SELECT json_group_array(kept.value)
         FROM (SELECT entry.value
                 FROM json_each(clients.redirect_uris) AS entry
                WHERE substr(entry.value, 1, 1) <> '/'
                ORDER BY entry.key) AS kept)
 WHERE EXISTS (
       SELECT 1
         FROM json_each(clients.redirect_uris) AS entry
        WHERE substr(entry.value, 1, 1) = '/');
