/**
 * The non-standard parameter a first-party client names the copy of the owner
 * UI it runs from with — its served root, e.g.
 * `https://wildflowerhealth.io/app/` or a PR preview's
 * `https://wildflowerhealthio.github.io/staging/pr-736/app/`.
 *
 * @remarks
 * Sent on `/oauth/authorize` (query), `/oauth/device_authorization` (form body)
 * and `/access/logout` (query). For a first-party client the server resolves the
 * pages it hands back — the polling page, the device-flow `verification_uri`,
 * logout's landing — on this base rather than on the host's configured owner
 * UI; any other client's value is ignored, and a value that is not an absolute
 * `http`/`https` URL is rejected with a `400`. The server's half is
 * `gatekeeper-rust`'s `domain/client_base_url.rs`, held equal to this by
 * `client-base-url.test.ts`.
 */
const CLIENT_BASE_URL_PARAM = 'wildflower_client_base_url'

export { CLIENT_BASE_URL_PARAM }
