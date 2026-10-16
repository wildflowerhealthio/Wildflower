/**
 * The mark a base's screen carries in its route's `staticData`, so the app
 * composing the base's routes can tell its matches from the app's own.
 */
declare module '@tanstack/react-router' {
  interface StaticDataRouteOption {
    /** Whether the route is one of the base's screens, or a layout over them. */
    readonly baseScreen?: true
  }
}

/** The `staticData` of a route that is one of the base's screens, or a layout over them. */
const BASE_SCREEN_STATIC_DATA = { baseScreen: true } as const

/** Whether a route whose `staticData` is `staticData` is one of the base's screens. */
const isBaseScreen = (staticData: { readonly baseScreen?: true }): boolean =>
  staticData.baseScreen === true

export { BASE_SCREEN_STATIC_DATA, isBaseScreen }
