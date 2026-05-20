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

describe('collectorSettingsRoutesFragment', () => {
  const settingsRoutePaths = declareFragmentPaths('collectorSettingsRoutesFragment')

  test('declares the account list and account config routes under /settings/collector', () => {
    expect(settingsRoutePaths).toContain('/settings/collector')
    expect(settingsRoutePaths).toContain('/settings/collector/account')
  })

  test('contains no public routes (all flows are owner-only)', () => {
    // If a `collectorPublicRoutesFragment` is ever introduced, this test
    // becomes the prompt to add a separate public-bucket assertion.
    expect(routesSource).not.toMatch(/collectorPublicRoutesFragment/)
  })

  test('no top-level /collector paths remain — moved under /settings/collector', () => {
    // The clean-rename decision: no redirect from `/collector` is kept,
    // so the slice should not declare any path that escapes /settings/.
    for (const path of settingsRoutePaths) {
      expect(path.startsWith('/settings/collector')).toBe(true)
    }
  })
})
