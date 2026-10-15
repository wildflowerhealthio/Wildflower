/**
 * The `user_code` the device page's query names (RFC 8628
 * `verification_uri_complete`, `/oauth/device?user_code=…`), or `''` when it
 * names none. The page only fills its code box with it; the Owner still
 * confirms the code.
 */
/** The query parameter that carries the code. */
const USER_CODE_PARAM = 'user_code'

const userCodeOf = (search: string): string =>
  new URLSearchParams(search).get(USER_CODE_PARAM) ?? ''

/**
 * `href` without its `user_code`, for the address bar once the code it named
 * is spent, so a reload shows an empty code box.
 */
const withoutUserCode = (href: string): string => {
  const url = new URL(href)
  url.searchParams.delete(USER_CODE_PARAM)
  return url.href
}

export { userCodeOf, withoutUserCode }
