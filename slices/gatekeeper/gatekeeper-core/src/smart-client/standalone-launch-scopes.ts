/**
 * The scope ceiling every Wildflower standalone-launch page asks for.
 *
 * Both seeded public clients — `wildflower-server-docs` (migration 0007) and
 * `wildflower-react` (migration 0012) — register the *same* `allowed_scopes`,
 * and `db/clients.rs` has a test that fails if one migration gains a scope the
 * other lacks. The browser side is the same story, so the list lives here once
 * rather than in a copy per app: a page that requests a scope its row does not
 * allow fails at `/oauth/authorize`.
 *
 * Asking wide is deliberate, and it is the argument both migrations make.
 * `allowed_scopes` is only the ceiling on what may be **requested**; the
 * Owner's consent step is where the grant is actually narrowed. Each of these
 * pages drives every documented slice surface, so neither can know in advance
 * which one the reader will open, and requesting less would 403 surfaces the
 * reader is entitled to.
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
