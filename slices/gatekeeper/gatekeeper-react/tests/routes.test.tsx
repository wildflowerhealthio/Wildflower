import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vite-plus/test'
import { GatekeeperPaths } from '../../gatekeeper-core/src/page-paths.ts'

// Read source as text rather than importing — importing pulls in every screen's
// transitive deps which fail to resolve under vitest without a rebuilt workspace dist.
const routesSource = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'routes.tsx'),
  'utf8'
)

// Captures each fragment's contents as `block`; iterate matches to split into
// public/authorized buckets. The drift test below cares which bucket a path
// lands in — public routes don't need a bearer; authorized ones do — so a
// path migrating between fragments without a corresponding intent change is
// a regression worth catching.
const declareFragmentPaths = (fragmentName: string): readonly string[] => {
  const fragmentRegex = new RegExp(`const\\s+${fragmentName}[^=]*=\\s*\\(([\\s\\S]*?)^\\)`, 'm')
  const fragmentMatch = fragmentRegex.exec(routesSource)
  if (fragmentMatch === null) {
    throw new Error(`Could not locate ${fragmentName} block in routes.tsx`)
  }
  const block = fragmentMatch[1] ?? ''
  const paths: string[] = []
  const pathRegex = /<Route\b[^>]*\bpath="([^"]+)"/g
  let pathMatch: RegExpExecArray | null
  while ((pathMatch = pathRegex.exec(block)) !== null) {
    paths.push(pathMatch[1] ?? '')
  }
  return paths
}

const publicRoutePaths = declareFragmentPaths('gatekeeperPublicRoutesFragment')
const authorizedRoutePaths = declareFragmentPaths('gatekeeperAuthorizedRoutesFragment')
const allDeclaredRoutePaths = [...publicRoutePaths, ...authorizedRoutePaths]

describe('GatekeeperPaths ↔ <Route path> drift', () => {
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
      expect(allDeclaredRoutePaths).toContain(expected)
    }
  })

  // Bucket assertions: oauth-polling and device-entry are reachable without
  // a bearer (the polling endpoint is unauth; device-entry is the page where
  // an owner types a code from another device). oauth-consent and
  // device-consent require the owner to already be authenticated.
  test('oauth-polling and device-entry are in the public fragment', () => {
    expect(publicRoutePaths).toContain(decodeURIComponent(GatekeeperPaths.oauthPollingPath(':id')))
    expect(publicRoutePaths).toContain(decodeURIComponent(GatekeeperPaths.deviceEntryPath()))
  })

  test('oauth-consent and device-consent are in the authorized fragment', () => {
    expect(authorizedRoutePaths).toContain(
      decodeURIComponent(GatekeeperPaths.oauthConsentPath(':id'))
    )
    expect(authorizedRoutePaths).toContain(
      decodeURIComponent(GatekeeperPaths.deviceConsentPath(':userCode'))
    )
  })
})
