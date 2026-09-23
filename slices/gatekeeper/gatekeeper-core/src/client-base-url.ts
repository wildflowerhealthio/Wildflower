/**
 * The non-standard parameter a first-party client names the owner UI copy it
 * runs from with (its served root), so the pages the server hands back resolve
 * on that copy. See "Client base URL" in the
 * [Jargon Explanation](../../docs/Jargon%20Explanation.md). Held equal to
 * `gatekeeper-rust`'s `domain/client_base_url.rs` by `client-base-url.test.ts`.
 */
const CLIENT_BASE_URL_PARAM = 'wildflower_client_base_url'

export { CLIENT_BASE_URL_PARAM }
