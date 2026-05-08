/**
 * Generic URL conventions shared across the interop boundary. Slice-specific
 * URL keys (e.g. `?token=`, `?user_code=`) live with their slice — only the
 * slice-neutral surface marker lives here.
 */

/** Query-string key used to flag that the page is being rendered inside the Expo host. */
const SURFACE_QUERY_KEY = 'surface'

/** Value of {@link SURFACE_QUERY_KEY} that identifies the Expo embedded surface. */
const SURFACE_EXPO = 'expo'

export { SURFACE_EXPO, SURFACE_QUERY_KEY }
