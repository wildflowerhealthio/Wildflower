import { useQuery } from '@tanstack/react-query'
import {
  formatInstant,
  type AuthorizationRouterContext,
} from '@wildflowerhealthio/authorization-react'
import { Option } from 'effect'
import type { JSX } from 'react'

import { sessionQueryOptions } from './session-query.ts'
import styles from './session-footer.module.css'

/**
 * Where the Sign out form posts: the server's sign-out, which revokes this
 * browser's session, clears its cookie and sends it on to the launcher. The
 * server's side is `authorization-server-rust`'s `routes/oauth/sign_out.rs`.
 */
const SIGN_OUT_PATH = '/oauth/sign-out'

interface SessionFooterProps {
  /** The runner over the browser session (see `browserSessionRunner`). */
  readonly runAuthed: AuthorizationRouterContext.RunAuthed
}

/**
 * The footer the consent card and the device page show under their content:
 * "Signed in until" this browser's session expires, and a Sign out button, a
 * plain form post to {@link SIGN_OUT_PATH}. It reads the expiry from the
 * page's own session read ({@link sessionQueryOptions}), and shows nothing for
 * a browser that isn't signed in (`401`), whose session can't be read, or
 * whose token is under no browser session. The pairing page has none: a
 * browser there is not signed in.
 */
const SessionFooter = ({ runAuthed }: SessionFooterProps): JSX.Element | null => {
  const sessionQuery = useQuery(sessionQueryOptions(runAuthed))
  return Option.fromNullable(sessionQuery.data).pipe(
    Option.flatten,
    Option.flatMapNullable(({ browserSessionExpiresAt }) => browserSessionExpiresAt),
    Option.map((expiresAt) => (
      <footer key="session-footer" className={styles['session-footer']}>
        <p className={styles['session-footer__expiry']}>
          Signed in until {formatInstant(expiresAt)}
        </p>
        <form method="post" action={SIGN_OUT_PATH} className={styles['session-footer__sign-out']}>
          <button type="submit" className="button-2">
            Sign out
          </button>
        </form>
      </footer>
    )),
    Option.getOrNull
  )
}

export { SessionFooter, SIGN_OUT_PATH }
export type { SessionFooterProps }
