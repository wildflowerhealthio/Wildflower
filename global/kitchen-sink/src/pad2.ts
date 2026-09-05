/**
 * Left-pad an integer to two digits with a leading zero — the `07` in
 * `2026-09-07`. The most common date/time formatter for a `YYYY-MM-DD` or
 * `HH:MM:SS` renderer that stays off `Intl` (formatting an already-known
 * numeric part, in the caller's own local layout).
 */
const pad2 = (n: number): string => String(n).padStart(2, '0')

export { pad2 }
