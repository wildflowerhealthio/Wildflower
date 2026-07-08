-- Add the per-app launch path inferred at install time. A self-hosted bundle
-- that ships a `launch.html` is a SMART launcher: the upload handler records the
-- origin-relative launch path here (with `{origin}`/`{launch}` placeholders the
-- launch handler substitutes per request), so a launch routes to
-- `/launch.html?...` instead of the bare origin (`index.html`). NULL means "no
-- launcher" — the app serves from its root, the pre-existing behavior every
-- migration-seeded row (e.g. patient-browser, which has no launch.html) keeps.
-- Run-once (index 5 = the 6th migration); appended after the shipped 005.
ALTER TABLE self_hosted_apps ADD COLUMN launch_path TEXT;
