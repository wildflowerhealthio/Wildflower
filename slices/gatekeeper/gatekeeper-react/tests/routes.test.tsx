import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vite-plus/test'
import { GatekeeperPaths } from '../../gatekeeper-core/src/page-paths.ts'

// Read source as text rather than importing — importing pulls in every screen's
// transitive deps which fail to resolve under vitest without a rebuilt workspace dist.
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

// One-direction drift only: owner-nav routes are intentionally absent from `GatekeeperPaths`.
test('every GatekeeperPaths redirect target has a matching <Route path>', () => {
  // Decode percent-encoded path params so `:id` aligns with `<Route path>` literals.
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
