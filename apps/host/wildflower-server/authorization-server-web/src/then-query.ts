import { Option } from 'effect'

/**
 * The query parameter the host app sets when it opens a page, in a browser
 * signed in as the Owner, to decide a request another browser or device made:
 * `?then=back`. Only the value `back` means anything.
 */
const THEN_PARAM = 'then'

/** The parts of the browser window {@link goBackOrClose} acts on. */
interface BrowserWindow {
  readonly history: Pick<History, 'length' | 'back'>
  readonly close: () => void
}

/**
 * Step back out of a decided page: back through `history` when there is an
 * entry to go back to, else close the window. A browser may refuse to close a
 * window no script opened; the page then stays on what it says once decided
 * (`DecidedThenBack`).
 */
const goBackOrClose = (browserWindow: BrowserWindow): void => {
  if (browserWindow.history.length > 1) {
    browserWindow.history.back()
  } else {
    browserWindow.close()
  }
}

/**
 * How a page whose query is `search` leaves once the Owner has decided:
 * `Some` of a step back out of `browserWindow` (see {@link goBackOrClose}) when
 * the query says `then=back`, `None` for any other `then`, or none, where the
 * page behaves as it does for the browser that made the request.
 */
const goBackOnceDecidedOf = (
  search: string,
  browserWindow: BrowserWindow
): Option.Option<() => void> =>
  new URLSearchParams(search).get(THEN_PARAM) === 'back'
    ? Option.some(() => {
        goBackOrClose(browserWindow)
      })
    : Option.none()

export { goBackOnceDecidedOf, goBackOrClose }
