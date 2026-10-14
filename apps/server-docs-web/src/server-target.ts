/**
 * What the console says about its target.
 *
 * The parsing itself belongs to every static Wildflower page that targets a
 * server the reader chooses, so it lives in
 * `authorization-core/smart-client` (`normalizeServerUrl`, `searchWithServerUrl`,
 * `serverUrlFromSearch`), and so does turning the `iss` of a SMART launch the
 * console is opened with into a `?server=` (`searchAfterArrivingLaunch`). There
 * is no default: a load whose URL names no usable server has no target, and the
 * header bar asks for one, as the hosted launcher's landing does. What stays
 * here is the console's wording for that ask, matching `smart-app-react`'s
 * `ConnectMenu` for a Wildflower server.
 */

import { normalizeServerUrl } from '@wildflowerhealthio/authorization-core/smart-client'

/** The example server URL the header bar's field and its messages show. */
const SERVER_URL_EXAMPLE = 'https://my-server.example.com'

/** What the status line says while the console has no target. */
const NO_SERVER_PROMPT = 'Enter your Wildflower server’s URL to browse its API and sign in to it.'

/**
 * Why `candidate` cannot be the console's target, or `undefined` when it can:
 * only an absolute `http(s)` URL names a server.
 */
const serverEntryProblem = (candidate: string): string | undefined =>
  normalizeServerUrl(candidate) === undefined
    ? `Enter a valid http(s) server URL, e.g. ${SERVER_URL_EXAMPLE}.`
    : undefined

export { NO_SERVER_PROMPT, SERVER_URL_EXAMPLE, serverEntryProblem }
