/**
 * What a host `<WebView>` should load. Mirrors `react-native-webview`'s
 * `source` prop shape (and `EffectMessagingWebViewSource`) so a host
 * component can pass values of these types straight through.
 *
 * The slice's `Remote.firstPage` is typed as {@link Any}; concrete
 * remotes choose whether to point at an external URL ({@link Uri}) or
 * to ship an inline page ({@link Html}).
 */
interface Uri {
  /**
   * The URI to load in the `WebView`. Can be a local or remote file.
   */
  uri: string
  /**
   * The HTTP Method to use. Defaults to GET if not specified.
   * NOTE: On Android, only GET and POST are supported.
   */
  method?: string
  /**
   * Additional HTTP headers to send with the request.
   * NOTE: On Android, this can only be used with GET requests.
   */
  headers?: object
  /**
   * The HTTP body to send with the request. This must be a valid
   * UTF-8 string, and will be sent exactly as specified, with no
   * additional encoding (e.g. URL-escaping or base64) applied.
   * NOTE: On Android, this can only be used with POST requests.
   */
  body?: string
}
interface Html {
  /**
   * A static HTML page to display in the WebView.
   */
  html: string
  /**
   * The base URL to be used for any relative links in the HTML.
   */
  baseUrl?: string
}

type Any = Uri | Html

export type { Uri, Html, Any }
