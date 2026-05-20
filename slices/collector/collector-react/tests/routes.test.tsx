import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vite-plus/test'

// Read source as text rather than importing — importing pulls in every screen's
// transitive deps (livestore, fhir-r4 client, kitchen-sink hooks) which fail to
// resolve under vitest without a rebuilt workspace dist. Mirrors the
// `slices/gatekeeper/gatekeeper-react/tests/routes.test.tsx` approach.
const routesSource = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'routes.tsx'),
  'utf8'
)

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

describe('collectorAuthenticatedRoutesFragment', () => {
  const routePaths = declareFragmentPaths('collectorAuthenticatedRoutesFragment')

  test('declares the account list and resource-styled account config routes under /collector', () => {
    expect(routePaths).toContain('/collector')
    expect(routePaths).toContain('/collector/account/new')
    expect(routePaths).toContain('/collector/account/:id')
  })

  test('contains no open routes (all flows are owner-only)', () => {
    // If a `collectorOpenRoutesFragment` is ever introduced, this test
    // becomes the prompt to add a separate open-bucket assertion.
    expect(routesSource).not.toMatch(/collectorOpenRoutesFragment/)
  })

  test('every path is under /collector — collector is top-level functionality, not a settings concern', () => {
    for (const path of routePaths) {
      expect(path === '/collector' || path.startsWith('/collector/')).toBe(true)
    }
  })

  test('no /settings/collector paths remain — collector is not under /settings/', () => {
    for (const path of routePaths) {
      expect(path.startsWith('/settings/')).toBe(false)
    }
  })
})
