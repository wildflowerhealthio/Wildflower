import { createBrowserHistory, type RouterHistory } from '@tanstack/react-router'

/**
 * What a routed SMART app's router runs over for the page's life: the
 * window's history and the served directory. Opened once, in the app's
 * `main.tsx`, by {@link openSmartAppPage}.
 */
interface SmartAppPage {
  /** The window's history, which the router navigates once the handshake completes. */
  readonly history: RouterHistory
  /** The directory the build is served from, slash-suffixed: the router's basepath. */
  readonly basepath: string
}

/**
 * The directory a build is served from, read off its entry module's URL,
 * which sits one directory below it: in `assets/` in a build, in `src/`
 * under the dev server. The page's own URL cannot say, since a load can land
 * on a deep route (a dev server's SPA fallback, a reload on a tab).
 *
 * @example servedDirectoryOf('https://importer.example/pr-7/assets/main-3f2a.js') // '/pr-7/'
 */
const servedDirectoryOf = (entryModuleUrl: string): string => new URL('..', entryModuleUrl).pathname

/**
 * The page a routed SMART app's router runs over, for an app whose entry
 * module is at `entryModuleUrl` (its `import.meta.url`).
 *
 * @remarks
 * Called once, at boot. Creating the history touches no URL (it only tags
 * the current entry's state); the router that reads and rewrites the URL is
 * built later, under `SmartHandshakeGate`.
 */
const openSmartAppPage = (entryModuleUrl: string): SmartAppPage => ({
  history: createBrowserHistory(),
  basepath: servedDirectoryOf(entryModuleUrl),
})

export { openSmartAppPage, servedDirectoryOf, type SmartAppPage }
