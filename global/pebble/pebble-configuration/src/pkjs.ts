/**
 * The watchapp's half of the Pebble "App Configuration (Static)" contract, for
 * its PebbleKit JS: the settings page's `webviewclosed` response, decoded.
 *
 * @remarks
 * Its own entry point because the phone's JavaScript runtime is ES5: nothing
 * reachable from here may import Effect or any other module that needs ES2015
 * at run time, or use an ES2015 library method. It imports nothing from the
 * rest of the package, not even types, so an app's type-check of its bundle
 * against ES5's library never loads Effect.
 *
 * @packageDocumentation
 */

/**
 * The value the settings page handed back through `ReturnTarget.handoffUrl`:
 * `response`, the `webviewclosed` event's, URI-decoded and parsed as JSON.
 * `unknown`, for the app's own decoder to check. Throws when the response is
 * not URI-encoded JSON.
 */
const decodeWebviewResponse = (response: string): unknown =>
  JSON.parse(decodeURIComponent(response))

export { decodeWebviewResponse }
