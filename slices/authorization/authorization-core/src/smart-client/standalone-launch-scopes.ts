/**
 * The scope ceiling the server-docs console, a standalone-launch page, asks for.
 *
 * It is the `allowed_scopes` of the console's seeded public client (migration
 * 0007, rekeyed by 0028), held in `authorization-core` beside the flow it feeds.
 *
 * Asking wide is deliberate, and it is the argument the migration makes.
 * `allowed_scopes` is only the ceiling on what may be **requested**; the
 * Owner's consent step is where the grant is actually narrowed. The console
 * drives every documented slice surface, so it cannot know in advance which one
 * the reader will open, and requesting less would 403 surfaces the reader is
 * entitled to.
 */

/** The scopes a standalone-launch page requests. */
const STANDALONE_LAUNCH_SCOPES: readonly string[] = [
  'openid',
  'profile',
  'fhirUser',
  'launch',
  'launch/patient',
  'offline_access',
  'wildflower/launch',
  'system/*.cruds',
  'wildflower/*.cruds',
]

/**
 * The space-delimited `scope` parameter form of {@link STANDALONE_LAUNCH_SCOPES}
 * (RFC 6749 §3.3), ready for a {@link SignInEnvironment}'s `scope`.
 */
const standaloneLaunchScopeParameter = (): string => STANDALONE_LAUNCH_SCOPES.join(' ')

export { STANDALONE_LAUNCH_SCOPES, standaloneLaunchScopeParameter }
