/**
 * The pending request id the consent card's path names:
 * `…/oauth/authorize/{id}/consent`, the id percent-decoded as the server
 * encoded it into the `Location` it sent the browser to. The server serves this
 * page at no other path.
 */
const requestIdOf = (pathname: string): string =>
  decodeURIComponent(pathname.split('/').slice(-2, -1)[0] ?? '')

export { requestIdOf }
