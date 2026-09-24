-- The hosted owner UI (`wildflower-react`, seeded by
-- 0012_seed_wildflower_react_client) returns from a sign-in to its app ROOT,
-- `https://wildflowerhealth.io/app/`, rather than to the `/app/home` route 0012
-- registered.
--
-- WHY THE ROOT. The root is the one address a static host serves as a real
-- file, so the callback reaches the app without a 404 redirect, and it is the
-- same value on every copy's outbound leg and callback. Where the reader was
-- headed (the auth gate's `?returnTo=`) rides the client's `sessionStorage`
-- pending record instead of the URL, and the app settles on it once the code is
-- redeemed — see `apps/wildflower-react/src/sign-in.ts`.
--
-- The list is REPLACED, not appended to: the old `/app/home` entry no longer
-- matches anything the app sends, and a redirect some other copy registered on
-- first use pointed at that copy's `/home` for the same reason. Those copies
-- ask on first use again, as they did before their first approval.
--
-- `wildflowerhealth.io/app/` MUST equal `REGISTERED_REDIRECT_URI` in
-- `apps/wildflower-react/src/sign-in.ts`, which is matched by exact string
-- equality; `sign-in.test.ts` reads this file to hold the two equal.
UPDATE clients
   SET redirect_uris = '["https://wildflowerhealth.io/app/"]'
 WHERE client_id = 'wildflower-react';
