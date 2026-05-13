/**
 * What a host `<WebView>` should load. Tagged discriminated union — the
 * `_tag` makes the variant explicit, so a single source value can flow
 * through the `RequestSniffableWebView` bridge wire schema (which
 * encodes `_tag` for serialization) and the host's native WebView prop
 * (which ignores the extra property at runtime; consumers strip it via
 * destructuring before forwarding to `react-native-webview` if their
 * typings reject unknown fields).
 *
 * The slice's `Remote.firstPage` is typed as {@link Any}; concrete
 * remotes choose whether to point at an external URL ({@link Uri}) or
 * to ship an inline page ({@link Html}).
 */
interface Uri {
  readonly _tag: 'Uri'
  /**
   * The URI to load in the `WebView`. Can be a local or remote file.
   */
  readonly uri: string
  /**
   * The HTTP Method to use. Defaults to GET if not specified.
   * NOTE: On Android, only GET and POST are supported.
   */
  readonly method?: string
  /**
   * Additional HTTP headers to send with the request.
   * NOTE: On Android, this can only be used with GET requests.
   */
  readonly headers?: object
  /**
   * The HTTP body to send with the request. This must be a valid
   * UTF-8 string, and will be sent exactly as specified, with no
   * additional encoding (e.g. URL-escaping or base64) applied.
   * NOTE: On Android, this can only be used with POST requests.
   */
  readonly body?: string
}
interface Html {
  readonly _tag: 'Html'
  /**
   * A static HTML page to display in the WebView.
   */
  readonly html: string
  /**
   * The base URL to be used for any relative links in the HTML.
   */
  readonly baseUrl?: string
}

type Any = Uri | Html

export type { Uri, Html, Any }
