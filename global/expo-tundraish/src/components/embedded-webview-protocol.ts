import { Schema } from 'effect'

/**
 * Page → host bridge messages. The embedded page sends these via
 * `window.ReactNativeWebView.postMessage(JSON.stringify(...))`.
 *
 * - `host:route` — drives the screen header's back chevron (`canGoBack` toggles whether the chevron renders).
 * - `host:ready` — declares the bundle has hydrated; dismisses the native loading overlay.
 * - `host:overrideReady` — opts the page out of the default `onLoadEnd` auto-ready. Send this in `injectedScript` so it lands before the page finishes loading. After the override, only `host:ready` will dismiss the overlay.
 * - `host:navigate` — asks the host to perform `router.push(path)`, e.g. to a different native screen.
 */
const PageToHostMessage = Schema.Union(
  Schema.Struct({ type: Schema.Literal('host:route'), canGoBack: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal('host:ready') }),
  Schema.Struct({ type: Schema.Literal('host:overrideReady') }),
  Schema.Struct({ type: Schema.Literal('host:navigate'), path: Schema.String })
)
type PageToHostMessage = typeof PageToHostMessage.Type

/**
 * Host → page bridge messages. The host pushes these into the WebView via
 * `webviewRef.current.postMessage(JSON.stringify(...))`. Embedded pages should
 * listen for them on `window`/`document` `message` events.
 *
 * - `host:back` — emitted when the user taps the screen header's back chevron. The page is expected to handle in-page back navigation (the host has already decided not to pop the native screen).
 */
const HostToPageMessage = Schema.Union(Schema.Struct({ type: Schema.Literal('host:back') }))
type HostToPageMessage = typeof HostToPageMessage.Type

const decodePageToHost = Schema.decodeOption(Schema.parseJson(PageToHostMessage))

export { decodePageToHost, HostToPageMessage, PageToHostMessage }
export type { HostToPageMessage as HostToPageMessageType, PageToHostMessage as PageToHostMessageType }
