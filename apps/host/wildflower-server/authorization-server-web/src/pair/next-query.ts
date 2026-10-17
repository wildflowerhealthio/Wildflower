/**
 * The `next` the pairing page's query names (`/oauth/pair?next=…`), where the
 * browser goes once it holds its session, or `''` when it names none. The page
 * doesn't judge it: the server allows only a path on its own origin, and
 * answers the start with the `next` it will send the browser to.
 */
const nextOf = (search: string): string => new URLSearchParams(search).get('next') ?? ''

export { nextOf }
