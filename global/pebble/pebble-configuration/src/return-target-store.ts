import type { Either } from 'effect'

import * as ReturnTarget from './return-target.ts'

/**
 * Keeps the Pebble phone app's `return_to` across a sign-in, such as an OAuth
 * login, which leaves the page for another site and lands back on the app root
 * without the query the page was opened with.
 *
 * @remarks
 * A namespace module — consumers speak `ReturnTargetStore.Store` and build one
 * with `ReturnTargetStore.fromWebStorage`. Pure: the storage it keeps the
 * target in, and the key it keeps it under, are parameters, so the browser's
 * `sessionStorage` is named only by the app.
 *
 * @packageDocumentation
 */

/** Where the page keeps the return target while the user signs in. */
interface Store {
  /**
   * Keep the return target the page was opened with. A page URL without one —
   * the sign-in's callback landing — leaves what is kept alone.
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

/**
 * A {@link Store} over Web Storage. The app hands it `sessionStorage`: the
 * target must outlive the sign-in's round trip in this tab, and nothing longer —
 * a target kept past the phone app's web view could send a later session's
 * settings somewhere the phone app no longer expects.
 *
 * @param key - The key the return target is kept under, one of the app's own
 */
const fromWebStorage = (storage: WebStorage, key: string): Store => ({
  rememberFrom: (pageUrl) => {
    const returnTo = pageUrl.searchParams.get(ReturnTarget.PARAM)
    if (returnTo !== null) storage.setItem(key, returnTo)
  },
  recall: () => ReturnTarget.decode(storage.getItem(key) ?? ReturnTarget.DEFAULT),
})

export { fromWebStorage }
export type { Store, WebStorage }
