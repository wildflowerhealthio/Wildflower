# pebble-configuration

The Pebble "App Configuration (Static)" contract, generic over what the
settings are. A watchapp's PebbleKit JS opens a hosted settings page on
`showConfiguration`; the Pebble phone app adds `?return_to=<url>`; the page
finishes by navigating to that URL with the settings JSON, URI-encoded,
appended; and the phone app hands that JSON to the watchapp's `webviewclosed`
handler.

For the settings page:

- `ReturnTarget` — `decode` checks `return_to` against the allow-list,
  failing with `ForeignReturnTargetError`; `handoffUrl(target, json)` is the URL
  that hands `json` back. `PARAM` is the query parameter, and `DEFAULT`
  (`pebblejs://close#`) is where to return when the page was opened without
  one.
- `ReturnTargetStore` — `fromWebStorage(storage, key)` keeps `return_to` in
  any Web Storage–shaped store under the app's own key, across a sign-in that
  leaves the page and lands back without the query.

For the watchapp's PebbleKit JS, as the Effect-free `pebble-configuration/pkjs`:

- `decodeWebviewResponse(response)` — the `webviewclosed` response,
  URI-decoded and parsed as JSON, `unknown` for the app's own decoder to check.

## Rules

- **`ReturnTarget` is a security boundary.** Settings may carry secrets (an
  access token, say), so an arbitrary `return_to` would let anyone who gets a
  user to open a crafted link collect that user's settings. Only the Pebble
  phone app's `pebblejs:` scheme and loopback `http(s)` (the `pebble` tool's
  emulator configuration server) decode. Don't widen the allow-list.
- **Keep the target in `sessionStorage`.** It must outlive the sign-in's round
  trip in this tab and nothing longer: a target kept past the phone app's web
  view could send a later session's settings somewhere the phone app no longer
  expects. The storage is a structural parameter, so the package names no DOM
  type.
- **The `pkjs` entry runs on ES5.** It imports nothing, not even from the rest
  of the package, so a watchapp's ES5 type-check never loads Effect (see
  [`pebble-pkjs`](../pebble-pkjs/README.md)).
- **No `URL.canParse`.** The page runs in the phone app's web view, and
  `URL.canParse` is missing from iOS 16's WKWebView and Chrome before 120, so
  `ReturnTarget` parses with a throwing `new URL`.
