import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vite-plus/test'
import * as GatekeeperPaths from '../../gatekeeper-core/src/page-paths.ts'

// The drift test reads routes.tsx as text rather than importing it. Importing
// the JSX module pulls in every screen and their transitive deps
// (`gatekeeper-core/clients`, telemetry-web, etc.); under vitest those subpath
// resolves fail when the workspace dist hasn't been rebuilt. Reading the
// source sidesteps that — the invariant we care about is that every
// redirect-target in `GatekeeperPaths` appears as a literal `<Route path>` in
// the source of `routes.tsx`, and a regex over the raw text catches drift just
// as reliably as walking the rendered React tree.
const routesSource = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'routes.tsx'),
  'utf8'
)

const declaredRoutePaths = ((): readonly string[] => {
  const paths: string[] = []
  const pattern = /<Route\b[^>]*\bpath="([^"]+)"/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(routesSource)) !== null) {
    paths.push(match[1] ?? '')
  }
  return paths
})()

// One-direction drift: every redirect target in `GatekeeperPaths` must have
// a matching `<Route path>`. We do NOT check the reverse — owner-navigation
// routes (`/gatekeeper`, `/gatekeeper/requests`, `/gatekeeper/approved/:id`)
// are intentionally absent from `GatekeeperPaths` because they're internal
// nav, not redirect targets. Those routes are validated by the screens
// themselves.
test('every GatekeeperPaths redirect target has a matching <Route path>', () => {
  // `*Path` builders percent-encode path params for path-segment use, but
  // `<Route path>` literals use the un-encoded ":param" form. Decode the
  // builder output so the two representations align.
  const expectedPaths: readonly string[] = [
    decodeURIComponent(GatekeeperPaths.oauthPollingPath(':id')),
    decodeURIComponent(GatekeeperPaths.oauthConsentPath(':id')),
    decodeURIComponent(GatekeeperPaths.deviceEntryPath()),
    decodeURIComponent(GatekeeperPaths.deviceConsentPath(':userCode')),
  ]

  for (const expected of expectedPaths) {
    expect(declaredRoutePaths).toContain(expected)
  }
})
