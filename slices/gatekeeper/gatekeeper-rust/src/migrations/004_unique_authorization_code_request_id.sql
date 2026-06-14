-- One authorization code per request. `authorization_code_by_request_id` reads
-- a single row; without uniqueness, two codes sharing a request_id would let it
-- return an arbitrary one (and the Owner-UI polling endpoint build a redirect
-- from the wrong code). A request is turned into a code exactly once — the
-- auto-approve fast path or owner consent — so uniqueness matches reality and
-- turns an accidental double-issue into a hard error rather than silent
-- ambiguity.
DROP INDEX authorization_codes_request_id_idx;

CREATE UNIQUE INDEX authorization_codes_request_id_idx
    ON authorization_codes(request_id);
