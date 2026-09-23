import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { SECTION_PATHS } from 'branding-core'

import type { SiteSection } from './assembly.ts'
import {
  escapingPaths,
  isWithin,
  missingRequiredPaths,
  resolveSections,
  siteSections,
} from './assembly.ts'

// apps/github-pages/src -> repo root
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const outDir = join(repoRoot, 'apps', 'github-pages', 'dist')

const sectionFor = (packageName: string): SiteSection => {
  const section = siteSections.find((s) => s.packageName === packageName)
  if (section === undefined) throw new Error(`No site section for ${packageName}`)
  return section
}

/** Path-segment arbitrary: no separators, no traversal, no empties. */
const segment = fc
  .string({ minLength: 1, maxLength: 12 })
  .filter((s) => !s.includes('/') && !s.includes('\\') && s !== '.' && s !== '..')

const sectionArb: fc.Arbitrary<SiteSection> = fc.record({
  packageName: segment,
  sourceDir: fc.array(segment, { minLength: 1, maxLength: 3 }).map((p) => p.join('/')),
  destPath: fc.oneof(
    fc.constant(''),
    fc.array(segment, { minLength: 1, maxLength: 3 }).map((p) => p.join('/'))
  ),
  requiredFiles: fc.array(segment, { maxLength: 4 }),
})

/** Like {@link segment}, but free to traverse out of its parent. */
const traversingSegment = fc.oneof(fc.constant('..'), fc.constant('.'), segment)

/** Sections whose destinations may escape the output directory. */
const escapingSectionArb: fc.Arbitrary<SiteSection> = fc.record({
  packageName: segment,
  sourceDir: fc.array(segment, { minLength: 1, maxLength: 3 }).map((p) => p.join('/')),
  destPath: fc.array(traversingSegment, { maxLength: 3 }).map((p) => p.join('/')),
  requiredFiles: fc.array(
    fc.array(traversingSegment, { minLength: 1, maxLength: 3 }).map((p) => p.join('/')),
    { maxLength: 4 }
  ),
})

describe('site layout', () => {
  it('serves the marketing site from the root of the artifact', () => {
    const [marketing] = resolveSections(repoRoot, outDir, [sectionFor('marketing-website')])
    expect(marketing?.to).toBe(outDir)
    // GitHub Pages only honours the custom domain when CNAME is at the root of
    // the uploaded artifact.
    expect(marketing?.requiredPaths).toContain(join(outDir, 'CNAME'))
    expect(marketing?.requiredPaths).toContain(join(outDir, 'index.html'))
  })

  it('serves the medications app from /medications-app with both SMART entries', () => {
    const [medication] = resolveSections(repoRoot, outDir, [sectionFor('medications-app')])
    expect(medication?.to).toBe(join(outDir, 'medications-app'))
    expect(medication?.requiredPaths).toEqual([
      join(outDir, 'medications-app', 'index.html'),
      join(outDir, 'medications-app', 'launch.html'),
    ])
  })

  it('serves the importer app from /importer-app with both SMART entries', () => {
    const [importer] = resolveSections(repoRoot, outDir, [sectionFor('wildflower-importer')])
    expect(importer?.to).toBe(join(outDir, 'importer-app'))
    expect(importer?.requiredPaths).toEqual([
      join(outDir, 'importer-app', 'index.html'),
      join(outDir, 'importer-app', 'launch.html'),
    ])
  })

  it('serves the server-docs console from /wildflower-server-docs', () => {
    const [serverDocs] = resolveSections(repoRoot, outDir, [sectionFor('wildflower-server-docs')])
    expect(serverDocs?.to).toBe(join(outDir, 'wildflower-server-docs'))
    expect(serverDocs?.requiredPaths).toEqual([
      join(outDir, 'wildflower-server-docs', 'index.html'),
    ])
  })

  it('serves the OHIF viewer from /ohif-viewer', () => {
    const [ohif] = resolveSections(repoRoot, outDir, [sectionFor('ohif-viewer')])
    expect(ohif?.to).toBe(join(outDir, 'ohif-viewer'))
    expect(ohif?.requiredPaths).toEqual([join(outDir, 'ohif-viewer', 'index.html')])
  })

  it('serves the web trace app from /web-trace-app with both SMART entries', () => {
    const [webTrace] = resolveSections(repoRoot, outDir, [sectionFor('wildflower-web-trace')])
    expect(webTrace?.to).toBe(join(outDir, 'web-trace-app'))
    expect(webTrace?.requiredPaths).toEqual([
      join(outDir, 'web-trace-app', 'index.html'),
      join(outDir, 'web-trace-app', 'launch.html'),
    ])
  })

  it('serves the hosted owner UI from /app with its SPA entry', () => {
    const [app] = resolveSections(repoRoot, outDir, [sectionFor('wildflower-react')])
    expect(app?.to).toBe(join(outDir, 'app'))
    expect(app?.requiredPaths).toEqual([join(outDir, 'app', 'index.html')])
  })

  it('resolves every destination inside the output directory', () => {
    fc.assert(
      fc.property(fc.array(sectionArb), (sections) => {
        for (const resolved of resolveSections(repoRoot, outDir, sections)) {
          expect(isAbsolute(resolved.from)).toBe(true)
          expect(isWithin(outDir, resolved.to)).toBe(true)
          for (const required of resolved.requiredPaths) {
            expect(isWithin(resolved.to, required)).toBe(true)
          }
        }
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('reports every path a traversing layout would write outside the output directory', () => {
    fc.assert(
      fc.property(fc.array(escapingSectionArb), (sections) => {
        const resolved = resolveSections(repoRoot, outDir, sections)
        const escaping = escapingPaths(outDir, resolved)
        const all = resolved.flatMap((s) => [s.to, ...s.requiredPaths])
        expect(escaping).toEqual(all.filter((p) => !isWithin(outDir, p)))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('keeps the published layout inside the output directory', () => {
    expect(escapingPaths(outDir, resolveSections(repoRoot, outDir))).toEqual([])
  })

  it('reports exactly the required paths that do not exist', () => {
    fc.assert(
      fc.property(fc.array(sectionArb), fc.func(fc.boolean()), (sections, predicate) => {
        const resolved = resolveSections(repoRoot, outDir, sections)
        const exists = (path: string): boolean => predicate(path)
        const missing = missingRequiredPaths(resolved, exists)
        const all = resolved.flatMap((s) => s.requiredPaths)
        expect(missing).toEqual(all.filter((p) => !exists(p)))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('should derive every destPath from SECTION_PATHS', () => {
    // Sorted arrays, not Sets: a new SECTION_PATHS key whose value collides
    // with an existing path would leave the Set unchanged but must still fail.
    const destPaths = siteSections.map((s) => s.destPath).toSorted()
    const sectionPathValues = Object.values(SECTION_PATHS).toSorted()
    expect(destPaths).toEqual(sectionPathValues)
  })

  it('should pin the deploy-contract paths as literal values', () => {
    const destPaths = siteSections.map((s) => s.destPath).toSorted()
    expect(destPaths).toEqual(
      [
        '',
        'app',
        'importer-app',
        'medications-app',
        'ohif-viewer',
        'web-trace-app',
        'wildflower-server-docs',
      ].toSorted()
    )
  })
})

describe('site-wide files', () => {
  it('provides a 404.html for GitHub Pages SPA redirect', () => {
    const fourOhFour = join(repoRoot, 'apps', 'github-pages', '404.html')
    expect(existsSync(fourOhFour)).toBe(true)
    const content = readFileSync(fourOhFour, 'utf8')
    expect(content).toContain('redirect')
    expect(content).toContain('index.html')
  })

  it('paints the 404.html with the design system canvas in both color schemes', () => {
    // The redirect page is on screen briefly before it hands off; painting the
    // same canvas the apps do avoids a white flash for dark-mode users.
    // Reading the values from the palette makes this fail if the canvas moves.
    const palette = readFileSync(
      join(repoRoot, 'global', 'react-tundraish', 'src', 'colors-custom.css'),
      'utf8'
    )
    const canvases = [...palette.matchAll(/--color-canvas:\s*(#[0-9a-f]{3,8})/gi)].map(
      ([, hex]) => hex ?? ''
    )
    expect(canvases).toHaveLength(2)
    const [light, dark] = canvases
    const content = readFileSync(join(repoRoot, 'apps', 'github-pages', '404.html'), 'utf8')
    const [base, darkBlock] = content.split('@media (prefers-color-scheme: dark)')
    expect(base).toContain(`background-color: ${light}`)
    expect(darkBlock).toContain(`background-color: ${dark}`)
  })
})

describe('layout reconciliation with the packages it assembles', () => {
  /**
   * The three first-party SMART apps: each builds into its own package's
   * default `dist/` and the site copies it from there. `appDir` is the folder
   * under `apps/`, which differs from the package name for two of them.
   */
  const firstPartyApps = [
    { packageName: 'medications-app', appDir: 'medications-app' },
    { packageName: 'wildflower-web-trace', appDir: 'web-trace' },
    { packageName: 'wildflower-importer', appDir: 'importer-web' },
  ] as const

  it.each(firstPartyApps)(
    'reads $packageName from the default dist its vite config leaves alone',
    ({ packageName, appDir }) => {
      // No `build.outDir`, so Vite writes the package's own `dist/`. If the app
      // ever redirects its output, this fails rather than the deploy silently
      // publishing a stale copy.
      const config = readFileSync(join(repoRoot, 'apps', appDir, 'vite.config.ts'), 'utf8')
      expect(config).not.toMatch(/\boutDir\s*:/)
      expect(sectionFor(packageName).sourceDir).toBe(`apps/${appDir}/dist`)
    }
  )

  it('sources the first-party apps only from their own packages', () => {
    // Nothing the site publishes is read out of the vendored self-hosted-apps
    // tree: that directory holds only the third-party patient-browser build.
    for (const section of siteSections) {
      expect(section.sourceDir.startsWith('slices/apps/self-hosted-apps')).toBe(false)
    }
  })

  it.each(firstPartyApps)(
    'requires exactly the HTML entries $packageName builds',
    ({ packageName, appDir }) => {
      // The app declares its entries explicitly, so the required files can be
      // reconciled against them: adding or dropping a SMART entry there without
      // updating the layout fails here instead of publishing a section whose
      // launch endpoint 404s.
      const dir = join(repoRoot, 'apps', appDir)
      const config = readFileSync(join(dir, 'vite.config.ts'), 'utf8')
      const entries = [...config.matchAll(/'\.\/([\w-]+\.html)'/g)].map(([, file]) => file ?? '')
      expect(entries.length).toBeGreaterThan(0)
      expect([...sectionFor(packageName).requiredFiles].toSorted()).toEqual(entries.toSorted())
      // The entries the config names are real files in the app, so the build
      // genuinely produces the required outputs.
      for (const entry of entries) expect(existsSync(join(dir, entry))).toBe(true)
    }
  )

  it.each(firstPartyApps)(
    'reports a missing $packageName entry as a required-path miss',
    ({ packageName }) => {
      // Assembly exits non-zero whenever this list is non-empty; dropping one
      // app's launch endpoint from an otherwise complete site must land in it.
      const resolved = resolveSections(repoRoot, outDir)
      const [section] = resolveSections(repoRoot, outDir, [sectionFor(packageName)])
      const absent = join(section?.to ?? '', 'launch.html')
      expect(missingRequiredPaths(resolved, (path) => path !== absent)).toEqual([absent])
    }
  )

  it('points at the marketing build output that carries the CNAME', () => {
    expect(existsSync(join(repoRoot, 'apps', 'marketing-website', 'public', 'CNAME'))).toBe(true)
    expect(sectionFor('marketing-website').sourceDir).toBe('apps/marketing-website/dist')
  })

  it('reads the server-docs console from the default dist its config leaves alone', () => {
    // The console declares no `build.outDir`, so Vite writes the package's
    // default `dist/`. If it ever redirects its output, this fails rather than
    // the deploy silently publishing a stale copy.
    const configPath = join(repoRoot, 'apps', 'wildflower-server-docs', 'vite.config.ts')
    const config = readFileSync(configPath, 'utf8')
    expect(config).not.toMatch(/\boutDir\s*:/)
    expect(sectionFor('wildflower-server-docs').sourceDir).toBe('apps/wildflower-server-docs/dist')
  })

  it('reads the hosted owner UI source dir from the wildflower-react web vite config', () => {
    // Pin the section to the `outDir` the app's hosted (`web`) build declares,
    // so this fails rather than silently publishing a stale copy if that build
    // ever moves its output.
    const configPath = join(repoRoot, 'apps', 'wildflower-react', 'vite.config.web.ts')
    const config = readFileSync(configPath, 'utf8')
    const declared = /outDir:\s*'([^']+)'/.exec(config)?.[1]
    expect(declared).toBeDefined()
    const expected = resolve(join(repoRoot, 'apps', 'wildflower-react'), declared ?? '')
    expect(join(repoRoot, sectionFor('wildflower-react').sourceDir)).toBe(expected)
  })

  it('reads the OHIF viewer from the dist its build script writes', () => {
    // The build script owns `dist/` outright (it removes and recreates it), so
    // this pins the assembly to the directory that script names rather than a
    // second copy of the path.
    const buildPath = join(repoRoot, 'apps', 'ohif-viewer', 'src', 'build.ts')
    const build = readFileSync(buildPath, 'utf8')
    expect(build).toMatch(/join\(packageRoot, 'dist'\)/)
    expect(sectionFor('ohif-viewer').sourceDir).toBe('apps/ohif-viewer/dist')
  })

  it('declares every assembled package as a workspace dependency', () => {
    const packageJson: unknown = JSON.parse(
      readFileSync(join(repoRoot, 'apps', 'github-pages', 'package.json'), 'utf8')
    )
    if (typeof packageJson !== 'object' || packageJson === null) throw new Error('Not an object')
    if (!('devDependencies' in packageJson)) throw new Error('No devDependencies')
    const { devDependencies } = packageJson
    if (typeof devDependencies !== 'object' || devDependencies === null) {
      throw new Error('devDependencies is not an object')
    }
    const declared = new Map(Object.entries(devDependencies))
    // Depending on each section is what makes the workspace's topological
    // build (`vp run pack`) produce its output before assembly copies it.
    for (const section of siteSections) {
      expect(declared.get(section.packageName)).toBe('workspace:*')
    }
  })
})
