/** Where sign-in lands when no usable `returnTo` was supplied. */
const POST_AUTH_DEFAULT_PATH = '/home'

/**
 * Resolve the post-sign-in destination from a caller-supplied
 * `?returnTo=` value, falling back to {@link POST_AUTH_DEFAULT_PATH}.
 *
 * The value is attacker-controllable (it rides a query parameter), so
 * only a **same-origin absolute path** is accepted: it must start with a
 * single `/`. Protocol-relative (`//evil.com`) and backslash-smuggled
 * (`/\evil.com`) forms — which a browser resolves to a *different
 * origin* — are rejected, closing the open-redirect hole. Anything else
 * (a full URL, a `javascript:` payload, an empty/missing value) also
 * falls back to the default.
 */
const sanitizeReturnTo = (raw: string | null): string => {
  if (raw === null || raw === '') return POST_AUTH_DEFAULT_PATH
  if (!raw.startsWith('/')) return POST_AUTH_DEFAULT_PATH
  if (raw.startsWith('//') || raw.startsWith('/\\')) return POST_AUTH_DEFAULT_PATH
  return raw
}

export { sanitizeReturnTo }
