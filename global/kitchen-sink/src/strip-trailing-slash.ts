/**
 * Remove a single trailing `/` from `value`. Idempotent: strings without
 * a trailing slash pass through unchanged.
 *
 * @remarks
 * Useful when concatenating an origin/base URL with a path that already
 * starts with `/` — the origin may or may not carry its own trailing
 * slash depending on how it was sourced (`window.location.origin`
 * doesn't, but server-rendered URLs sometimes do). Strip first, then
 * join with `/`-prefixed path to avoid `//` doubling.
 *
 * Only the last `/` is removed; `"foo//"` becomes `"foo/"`, not `"foo"`.
 * Pass twice (or fold to a different helper) if multiple trailing
 * slashes need stripping.
 */
const stripTrailingSlash = (value: string): string =>
  value.endsWith('/') ? value.slice(0, -1) : value

export { stripTrailingSlash }
