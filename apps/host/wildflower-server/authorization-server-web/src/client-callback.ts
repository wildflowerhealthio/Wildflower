import { Option } from 'effect'

/**
 * `redirect`, the client callback a decision's answer carries, as a URL the
 * page may leave for: an absolute `http:` or `https:` URL, or `None` for
 * anything else. The authorization server builds the callback from the
 * client's allowlisted (or just-approved) `redirect_uri`; only an http(s) URL
 * is followed all the same, so a malformed answer can never run script on the
 * page, as the wait page's `wait.js` holds too.
 */
const followableClientCallback = (redirect: string): Option.Option<URL> =>
  Option.liftThrowable(() => new URL(redirect))().pipe(
    Option.filter((callback) => callback.protocol === 'http:' || callback.protocol === 'https:')
  )

export { followableClientCallback }
