/**
 * The pending request id a request page's path names:
 * `…/oauth/authorize/{id}/consent` (the consent card) or
 * `…/oauth/authorize/{id}/limited` (the limited page), the id percent-decoded
 * as the server encoded it into the `Location` it sent the browser to. The
 * server serves these pages at no other paths.
 */
const requestIdOf = (pathname: string): string =>
  decodeURIComponent(pathname.split('/').slice(-2, -1)[0] ?? '')

export { requestIdOf }
