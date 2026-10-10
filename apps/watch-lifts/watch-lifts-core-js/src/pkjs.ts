/**
 * The part of WatchLifts' core the watchapp's PebbleKit JS runs: the settings
 * page's weights decoded, kept, and sent to the watch.
 *
 * @remarks
 * Its own entry point because the phone's JavaScript runtime is ES5: nothing
 * reachable from here may import Effect or any other module that needs ES2015
 * at run time, or use an ES2015 library method. Its modules import nothing
 * from the rest of the package, not even types, which keeps the watchapp's
 * type-check against ES5's library small. That build
 * (`apps/watch-lifts/watch-lifts-watchapp/pkjs`) lowers the syntax to ES5 and fails on an ES2015
 * method or global.
 *
 * - {@link Lifts} — the exercises, the people and the default weights.
 * - {@link PhoneSettings} — the weights the phone keeps, the page's URL
 *   pre-filled with them, and the watch's message.
 *
 * @packageDocumentation
 */
export * as Lifts from './lifts.ts'
export * as PhoneSettings from './phone-settings.ts'
