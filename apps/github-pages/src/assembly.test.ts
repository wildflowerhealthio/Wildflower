import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

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

  it('serves the server-docs console from /wildflower-server-docs', () => {
    const [serverDocs] = resolveSections(repoRoot, outDir, [sectionFor('wildflower-server-docs')])
    expect(serverDocs?.to).toBe(join(outDir, 'wildflower-server-docs'))
    expect(serverDocs?.requiredPaths).toEqual([
      join(outDir, 'wildflower-server-docs', 'index.html'),
    ])
  })

  it('serves the web trace app from /web-trace-app with both SMART entries', () => {
    const [webTrace] = resolveSections(repoRoot, outDir, [sectionFor('wildflower-web-trace')])
    expect(webTrace?.to).toBe(join(outDir, 'web-trace-app'))
    expect(webTrace?.requiredPaths).toEqual([
      join(outDir, 'web-trace-app', 'index.html'),
      join(outDir, 'web-trace-app', 'launch.html'),
    ])
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
})

describe('layout reconciliation with the packages it assembles', () => {
  it('reads the medications source dir from the medications app vite config', () => {
    // Deriving the expected path from the config (rather than pinning a second
    // literal copy of it) is what makes this test able to fail if the
    // medications app ever moves its build output.
    const configPath = join(repoRoot, 'apps', 'medications-app', 'vite.config.ts')
    const config = readFileSync(configPath, 'utf8')
    const declared = /outDir:\s*'([^']+)'/.exec(config)?.[1]
    expect(declared).toBeDefined()
    const expected = resolve(join(repoRoot, 'apps', 'medications-app'), declared ?? '')
    expect(join(repoRoot, sectionFor('medications-app').sourceDir)).toBe(expected)
  })

  it('reads the web trace source dir from the web trace app vite config', () => {
    // Same reasoning as the medications case: derive the path rather than
    // pinning a second literal copy, so this fails if the app moves its output.
    const configPath = join(repoRoot, 'apps', 'web-trace', 'vite.config.ts')
    const config = readFileSync(configPath, 'utf8')
    const declared = /outDir:\s*'([^']+)'/.exec(config)?.[1]
    expect(declared).toBeDefined()
    const expected = resolve(join(repoRoot, 'apps', 'web-trace'), declared ?? '')
    expect(join(repoRoot, sectionFor('wildflower-web-trace').sourceDir)).toBe(expected)
  })

  it('requires exactly the HTML entries the web trace app builds', () => {
    // The app declares its entries explicitly, so the required files can be
    // reconciled against them: adding or dropping a SMART entry there without
    // updating the layout fails here instead of publishing a section whose
    // launch endpoint 404s.
    const appDir = join(repoRoot, 'apps', 'web-trace')
    const config = readFileSync(join(appDir, 'vite.config.ts'), 'utf8')
    const entries = [...config.matchAll(/'\.\/([\w-]+\.html)'/g)].map(([, file]) => file ?? '')
    expect(entries.length).toBeGreaterThan(0)
    expect([...sectionFor('wildflower-web-trace').requiredFiles].toSorted()).toEqual(
      entries.toSorted()
    )
    // The entries the config names are real files in the app, so the build
    // genuinely produces the required outputs.
    for (const entry of entries) expect(existsSync(join(appDir, entry))).toBe(true)
  })

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
