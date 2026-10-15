/**
 * The `user_code` the device page's query names (RFC 8628
 * `verification_uri_complete`, `/oauth/device?user_code=…`), or `''` when it
 * names none. The page only fills its code box with it; the Owner still
 * confirms the code.
 */
const userCodeOf = (search: string): string => new URLSearchParams(search).get('user_code') ?? ''

export { userCodeOf }
