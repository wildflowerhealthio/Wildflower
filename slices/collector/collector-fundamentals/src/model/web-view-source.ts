import { Schema } from 'effect'

/**
 * What a host `<WebView>` should load. Tagged discriminated union — the
 * `_tag` makes the variant explicit, so a single source value can flow
 * through the `Open` bridge wire schema (which encodes `_tag` for
 * serialization) and the host's native WebView prop (which ignores the
 * extra property at runtime; consumers strip it via destructuring before
 * forwarding to `react-native-webview` if their typings reject unknown
 * fields).
 *
 * A plan's navigation `Open` steps carry an {@link Any}; each chooses whether
 * to point at an external URL ({@link Uri}) or to ship an inline page
 * ({@link Html}). (The sniffer webview itself is always mounted on
 * `about:blank` by the host, so the *mount* message carries no source.)
 *
 * The schemas are exported so the `Open` bridge wire schema in `bridge.ts` can
 * reuse them — keeping a single source of truth for the host-side type and the
 * wire shape.
 */

/**
 * Refined string schema accepting only `http(s)://`-prefixed URIs. The
 * collector deliberately refuses `file://`, `javascript:`, `data:`,
 * etc., so a malformed `RequestSniffableWebView` message fails to
 * decode at the bridge boundary rather than reaching the host's
 * `<WebView>` props. Plain `http://` is permitted alongside `https://`
 * so a FHIR server reachable only over http (e.g. a local dev HAPI
 * instance) can still be sniffed — `InstanceConfig.rootUrl` likewise
 * accepts both schemes.
 */
const HttpUriString = Schema.String.pipe(
  Schema.filter((s) => s.startsWith('https://') || s.startsWith('http://'), {
    description: 'HTTP(S) URI only (http(s)://…)',
  })
)

const UriSchema = Schema.TaggedStruct('Uri', {
  /**
   * The URI to load in the `WebView`. Must be `http(s)://`-prefixed.
   */
  uri: HttpUriString,
  /**
   * The HTTP Method to use. Defaults to GET if not specified.
   * NOTE: On Android, only GET and POST are supported.
   */
  method: Schema.optional(Schema.String),
  /**
   * Additional HTTP headers to send with the request.
   * NOTE: On Android, this can only be used with GET requests.
   */
  headers: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  /**
   * The HTTP body to send with the request. This must be a valid
   * UTF-8 string, and will be sent exactly as specified, with no
   * additional encoding (e.g. URL-escaping or base64) applied.
   * NOTE: On Android, this can only be used with POST requests.
   */
  body: Schema.optional(Schema.String),
})

const HtmlSchema = Schema.TaggedStruct('Html', {
  /**
   * A static HTML page to display in the WebView.
   */
  html: Schema.String,
  /**
   * The base URL to be used for any relative links in the HTML.
   */
  baseUrl: Schema.optional(Schema.String),
})

const AnySchema = Schema.Union(UriSchema, HtmlSchema)

type Uri = Schema.Schema.Type<typeof UriSchema>
type Html = Schema.Schema.Type<typeof HtmlSchema>
type Any = Schema.Schema.Type<typeof AnySchema>

export { UriSchema, HtmlSchema, AnySchema }
export type { Uri, Html, Any }
