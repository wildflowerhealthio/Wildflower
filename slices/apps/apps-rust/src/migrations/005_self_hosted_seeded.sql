-- Mark which self-hosted rows are migration-seeded (protected, read-only) vs.
-- created at runtime through the upload surface. Every row that already exists
-- when this migration runs is by definition part of the seeded set, so backfill
-- those to 1; the column defaults to 0, which every future (uploaded) row keeps.
-- Run-once (index 4 = the 5th migration); appended after the shipped 004.
ALTER TABLE self_hosted_apps ADD COLUMN seeded INTEGER NOT NULL DEFAULT 0;
UPDATE self_hosted_apps SET seeded = 1;
