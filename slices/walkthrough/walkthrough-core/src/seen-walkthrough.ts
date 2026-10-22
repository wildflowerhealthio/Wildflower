import { Option, Schema } from 'effect'

/** How a visitor left a walkthrough: through its last step, or before it. */
const WalkthroughOutcome = Schema.Literal('Finished', 'Skipped')
type WalkthroughOutcome = typeof WalkthroughOutcome.Type

/**
 * A visitor having been through one walkthrough, as kept in the browser's
 * `localStorage`.
 *
 * @remarks
 * `version` is the version of the walkthrough's steps the visitor saw, so an
 * app that raises it shows the updated walkthrough again; `outcome` is whether
 * they finished or skipped it; `decidedAt` is when, kept as an ISO-8601
 * timestamp.
 */
const SeenWalkthrough = Schema.Struct({
  version: Schema.Int,
  outcome: WalkthroughOutcome,
  decidedAt: Schema.DateTimeUtc,
})
type SeenWalkthrough = typeof SeenWalkthrough.Type

/**
 * The Web Storage–shaped slice the record is kept in. Declared structurally
 * so this package names no DOM type: the app passes `window.localStorage`, and
 * a test a `Map`-backed stand-in.
 */
interface WalkthroughStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/**
 * The `localStorage` key the record for `walkthroughId` is kept under. Storage
 * is per origin, and every app has its own, so the id only has to be unique
 * within one app.
 */
const seenWalkthroughStorageKey = (walkthroughId: string): string =>
  `wildflower.walkthrough.${walkthroughId}`

const StoredSeenWalkthrough = Schema.parseJson(SeenWalkthrough)

const decodeStoredSeenWalkthrough = Schema.decodeUnknownOption(StoredSeenWalkthrough)

const encodeStoredSeenWalkthrough = Schema.encodeSync(StoredSeenWalkthrough)

/**
 * The visitor's way through the current version of a walkthrough, or
 * `undefined` while they have not been through it.
 *
 * @param storage - Where the record is kept (`window.localStorage` in an app)
 * @param walkthroughId - Which of the app's walkthroughs to read
 * @param currentVersion - The version of the steps the app shows
 * @returns The stored record when one is present, decodes, and is for
 *   `currentVersion`; `undefined` otherwise
 *
 * @remarks
 * A record that does not decode, or that is for another version, reads as
 * unseen rather than failing: the walkthrough shows again and its outcome
 * replaces the record.
 */
const readSeenWalkthrough = (
  storage: WalkthroughStorage,
  walkthroughId: string,
  currentVersion: number
): SeenWalkthrough | undefined =>
  Option.fromNullable(storage.getItem(seenWalkthroughStorageKey(walkthroughId))).pipe(
    Option.flatMap(decodeStoredSeenWalkthrough),
    Option.filter((seenWalkthrough) => seenWalkthrough.version === currentVersion),
    Option.getOrUndefined
  )

/** Keep `seenWalkthrough` as the record for `walkthroughId`, replacing any earlier one. */
const writeSeenWalkthrough = (
  storage: WalkthroughStorage,
  walkthroughId: string,
  seenWalkthrough: SeenWalkthrough
): void => {
  storage.setItem(
    seenWalkthroughStorageKey(walkthroughId),
    encodeStoredSeenWalkthrough(seenWalkthrough)
  )
}

export type { WalkthroughStorage }
export {
  readSeenWalkthrough,
  SeenWalkthrough,
  seenWalkthroughStorageKey,
  WalkthroughOutcome,
  writeSeenWalkthrough,
}
