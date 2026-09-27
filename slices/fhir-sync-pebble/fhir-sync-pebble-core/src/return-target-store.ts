import type { Either } from 'effect'

import * as ReturnTarget from './return-target.ts'

/**
 * Keeps the Pebble phone app's `return_to` across the SMART login, which leaves
 * the page for the server's authorize screen and lands back on the app root
 * without the query the page was opened with.
 *
 * @remarks
 * A namespace module — consumers speak `ReturnTargetStore.Store` and build one
 * with `ReturnTargetStore.fromWebStorage`. Pure: the storage it keeps the
 * target in is a parameter, so the browser's `sessionStorage` is named only by
 * the app.
 *
 * @packageDocumentation
 */

/** Where the page keeps the return target while the user signs in. */
interface Store {
  /**
   * Keep the return target the page was opened with. A page URL without one —
   * the OAuth callback landing — leaves what is kept alone.
   */
  readonly rememberFrom: (pageUrl: URL) => void
  /**
   * The kept return target, decoded; the guide's default when the page was
   * never opened with one.
   */
  readonly recall: () => Either.Either<ReturnTarget.Type, ReturnTarget.ForeignReturnTargetError>
}

/**
 * The Web Storage–shaped slice a {@link Store} keeps the target in. Declared
 * structurally so this package names no DOM type: the app passes
 * `window.sessionStorage`, and a test a `Map`-backed stand-in.
 */
interface WebStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** The key the return target is kept under. */
const STORAGE_KEY = 'fhir-sync-pebble:return-to'

/**
 * A {@link Store} over Web Storage. The app hands it `sessionStorage`: the
 * target must outlive the OAuth round trip in this tab, and nothing longer —
 * a target kept past the phone app's web view could send a later session's
 * settings somewhere the phone app no longer expects.
 */
const fromWebStorage = (storage: WebStorage): Store => ({
  rememberFrom: (pageUrl) => {
    const returnTo = pageUrl.searchParams.get(ReturnTarget.PARAM)
    if (returnTo !== null) storage.setItem(STORAGE_KEY, returnTo)
  },
  recall: () => ReturnTarget.decode(storage.getItem(STORAGE_KEY) ?? ReturnTarget.DEFAULT),
})

export { fromWebStorage, STORAGE_KEY }
export type { Store, WebStorage }
