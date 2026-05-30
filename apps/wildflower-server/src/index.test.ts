import { describe, expect, test } from 'vite-plus/test'

import { WildflowerHttpApi } from './index.ts'

/**
 * Regression guard for the slice-composer contract: `CollectorApi` lives
 * in `slices/collector/collector-core` without an internal
 * `.middleware(RequireAuthMiddleware)` annotation; the gating happens at
 * the server composition site (`addHttpApi(CollectorApi.middleware(...))`).
 * If a future edit drops the `.middleware(...)` call from
 * `apps/wildflower-server/src/index.ts`, the collector group's
 * `middlewares` set loses the `RequireAuthMiddleware` tag and write
 * endpoints silently expose to unauthenticated clients.
 *
 * `HttpApi` and each `HttpApiGroup` expose their applied middlewares as
 * a `ReadonlySet<TagClassAny>` (see `@effect/platform/HttpApi.d.ts`); the
 * regression check iterates the set and looks up the well-known tag
 * identifier `'RequireAuthMiddleware'`. Going through `.key` (the
 * Effect `Context.Tag` identifier) keeps the test independent of
 * `gatekeeper-core` class-identity variance.
 *
 * See `slices/collector/collector-core/src/http-api-definition/index.ts`
 * for the slice-side warning comment.
 */
const groupHasMiddleware = (
  groupName: keyof typeof WildflowerHttpApi.groups,
  middlewareKey: string
): boolean => {
  const group = WildflowerHttpApi.groups[groupName]
  if (group === undefined) return false
  for (const middleware of group.middlewares) {
    if (middleware.key === middlewareKey) return true
  }
  return false
}

describe('WildflowerHttpApi auth middleware regression guard', () => {
  test('collector group is gated by RequireAuthMiddleware', () => {
    expect(
      groupHasMiddleware('collector-remotes', 'RequireAuthMiddleware'),
      'collector-remotes group lost its RequireAuthMiddleware gate — auth must be reapplied at the server composition site'
    ).toBe(true)
  })

  test('fhir-r4 Patient group is gated by RequireAuthMiddleware', () => {
    // Sanity check: the same gating is also expected for the FHIR
    // resources API, which was already wired before this PR. If a
    // future composer drops it, this catches the regression too.
    expect(groupHasMiddleware('Patient', 'RequireAuthMiddleware')).toBe(true)
  })
})
