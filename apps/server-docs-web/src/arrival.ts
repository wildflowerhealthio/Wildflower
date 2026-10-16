/**
 * How a page load of the console settles what it arrived with: the query
 * string it leaves in the address bar, the server a return leg comes back
 * to, and the sign-in controls it shows when the back-forward cache hands it
 * back.
 *
 * `main.ts` wires both to `window`; they are here so that wiring is tested.
 */

import {
  isAuthorizationResponse,
  parsePendingAuthorization,
  searchAfterArrivingLaunch,
  searchWithoutAuthorizationResponse,
  type PendingStore,
} from '@wildflowerhealthio/authorization-core/smart-client'
import { Option } from 'effect'

/**
 * The query string a load arriving with `arrivalSearch` settles on, once what
 * it arrived with is spent.
 *
 * A return leg from `/oauth/authorize` drops the authorization response,
 * including the `iss` an authorization server adds beside it (RFC 9207): left
 * in the URL, the code or error would travel on in history, the referrer and
 * a copied link, and the `iss` would read as a SMART launch on reload. A SMART
 * launch becomes the `?server=` its `iss` names, so a reload offers the authorization server
 * no launch it has already spent. Any other load settles on what it arrived
 * with.
 */
const searchSettledFrom = (arrivalSearch: string): string =>
  isAuthorizationResponse(arrivalSearch)
    ? searchWithoutAuthorizationResponse(arrivalSearch)
    : searchAfterArrivingLaunch(arrivalSearch)

/**
 * The server the sign-in this tab is waiting on was started for, from its
 * pending record in `store` at `key`; `undefined` when there is none, or the
 * storage refuses to be read.
 *
 * Read before `completeSignIn`, which drops the record on a return leg: the
 * redirect URI carries no `?server=`, so this is how a failed or cancelled
 * return gets back to the server the reader picked.
 */
const pendingSignInServerUrl = (
  store: Pick<PendingStore, 'getItem'>,
  key: string
): string | undefined => {
  try {
    return parsePendingAuthorization(store.getItem(key)).pipe(
      Option.map((pending) => pending.serverUrl),
      Option.getOrUndefined
    )
  } catch {
    return undefined
  }
}

/**
 * Run `resetAuthControls` whenever `page` is restored from the back-forward
 * cache.
 *
 * A sign-in leaves the page with the button disabled and the status asking the
 * server how to sign in; Back from the authorization server can restore it
 * exactly as it was. Starting over instead puts the controls back to idle, as
 * `smart-app-react`'s `ConnectMenu` does. An ordinary load's `pageshow` is not a
 * restore and leaves them alone.
 */
const resetAuthControlsOnBackForwardRestore = (
  page: Pick<Window, 'addEventListener'>,
  resetAuthControls: () => void
): void => {
  page.addEventListener('pageshow', (event) => {
    if (event.persisted) resetAuthControls()
  })
}

export { pendingSignInServerUrl, resetAuthControlsOnBackForwardRestore, searchSettledFrom }
