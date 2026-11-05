/**
 * The OAuth redirect URI for a SMART app, from the URL of any of its pages:
 * the directory the app is served from, `basepath`, on `href`'s origin,
 * without the page's query or fragment. Without `basepath` it is
 * `href`'s own directory (`new URL('.', href)`), right for an app whose every
 * page sits at its root.
 *
 * @param href - The page's URL.
 * @param basepath - The directory the app is served from, as an absolute,
 *   slash-suffixed path (`SmartAppPage.basepath`, e.g. `/pr-7/`). A routed app
 *   passes it, since a launch can open one of its deep routes
 *   (`/patients/123/today?iss=…`), whose own directory is no registered
 *   redirect URI.
 *
 * @remarks
 * The app root, which serves `index.html`, is the one redirect target for every
 * way in: a launch it was opened to start (`arrivingSmartLaunchFrom`), a
 * standalone launch from the connect menu, and a failed launch sent back with
 * `launchErrorRedirect`. It is the page that completes the sign-in
 * (`completeSignInAfterRedirectHere`) and the page that can show a
 * failure, so a launch always returns there. Every such page
 * derives the same value, and the value is the same on the way out and on the
 * callback whatever query the page carries.
 *
 * Derived from the page URL rather than configured, so the bundle works at
 * whatever origin and path it is served from. It is not `authorization-core`'s
 * `redirectUriForPage`: there is no plaintext screen, because the registered
 * client's redirect URIs decide where a launch may return, and any userinfo the
 * page URL carries is kept.
 */
const appRootRedirectUri = (href: string, basepath = '.'): string => new URL(basepath, href).href

export { appRootRedirectUri }
