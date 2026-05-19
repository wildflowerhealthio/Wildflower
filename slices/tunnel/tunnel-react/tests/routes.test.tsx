import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vite-plus/test'

// Read source as text rather than importing — importing the routes
// module pulls in every screen's transitive deps, which fail to resolve
// under vitest without a rebuilt workspace dist. Mirrors the same
// drift-test technique used by gatekeeper-react/tests/routes.test.tsx.
const routesSource = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'routes.tsx'),
  'utf8'
)

// Captures the fragment's contents as `block`; iterate matches to pull
// out each declared <Route path="…">. The drift test asserts the
// fragment contains the documented `/tunnel` mount point.
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

const authorizedRoutePaths = declareFragmentPaths('tunnelAuthorizedRoutesFragment')

describe('tunnelAuthorizedRoutesFragment', () => {
  test('mounts /tunnel', () => {
    expect(authorizedRoutePaths).toContain('/tunnel')
  })

  test('declares exactly one route (the screen)', () => {
    // The slice's full surface is one settings page. If the count grows,
    // the test should be expanded deliberately rather than silently.
    expect(authorizedRoutePaths.length).toBe(1)
  })
})
