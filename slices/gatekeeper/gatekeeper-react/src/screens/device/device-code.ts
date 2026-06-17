/** RFC 8628 user-code shape this app issues: two four-character groups. */
const DEVICE_CODE_PATTERN = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/

/**
 * Normalize raw input toward the `XXXX-XXXX` user-code shape: upper-case,
 * drop characters outside the RFC 8628 alphabet, and re-insert the single
 * separating hyphen once more than four code characters are present.
 */
const normalize = (raw: string): string => {
  const upper = raw.toUpperCase().replace(/[^BCDFGHJKLMNPQRSTVWXZ-]/g, '')
  const stripped = upper.replace(/-/g, '')
  if (stripped.length <= 4) return stripped
  return `${stripped.slice(0, 4)}-${stripped.slice(4, 8)}`
}

export { DEVICE_CODE_PATTERN, normalize }
