import { existsSync, globSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Effect } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import { APP_SLUGS, sectionUrl } from '../../slices/branding/branding-core/src/site.ts'
import { findAffectedPackages, loadPackages, type Pkg } from '../affected-packages.ts'
import {
  affectedSites,
  APP_PAGES_SITES,
  MARKETING_PAGES_SITE,
  missingRequiredFiles,
  PAGES_SITES,
  type PagesSite,
} from './pages-sites.ts'

// scripts/ci/ sits two levels under the repo root.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const workspacePackages = Effect.runSync(loadPackages(repoRoot))

/** The workspace package that builds `site`. */
const packageOf = (site: PagesSite): Pkg => {
  const pkg = workspacePackages.find((candidate) => candidate.name === site.packageName)
  if (pkg === undefined) throw new Error(`No workspace package ${site.packageName}`)
  return pkg
}

describe('pages-sites / the sites', () => {
  it("should publish every hosted app from its own repository's gh-pages, at its own origin", () => {
    expect(APP_PAGES_SITES.map(({ section }) => section).toSorted()).toEqual(
      Object.keys(APP_SLUGS).toSorted()
    )
    for (const site of APP_PAGES_SITES) {
      if (site.section === 'marketing') throw new Error('Marketing among the apps')
      expect(site.name).toBe(APP_SLUGS[site.section])
      expect(site.pagesRepository).toBe(`${APP_SLUGS[site.section]}-web`)
      expect(site.pagesBranch).toBe('gh-pages')
      expect(site.siteUrl).toBe(sectionUrl(site.section))
    }
  })

  it('should name every site distinctly', () => {
    const names = PAGES_SITES.map(({ name }) => name)
    expect(new Set(names).size).toBe(names.length)
  })

  it("should read each site's build from inside its own package", () => {
    for (const site of PAGES_SITES) {
      expect(site.buildDir.startsWith(`${packageOf(site).relDir}/`)).toBe(true)
    }
  })

  it('should read the build each package writes', () => {
    for (const site of PAGES_SITES) {
      const dir = join(repoRoot, packageOf(site).relDir)
      const webConfig = join(dir, 'vite.config.web.ts')
      const buildScript = join(dir, 'src', 'build.ts')
      if (existsSync(webConfig)) {
        // The launcher's hosted build declares its own `outDir`.
        const declared = /outDir:\s*'([^']+)'/.exec(readFileSync(webConfig, 'utf8'))?.[1] ?? ''
        expect(join(repoRoot, site.buildDir)).toBe(resolve(dir, declared))
      } else if (existsSync(buildScript)) {
        // The OHIF viewer's build script owns `dist/` outright.
        expect(readFileSync(buildScript, 'utf8')).toMatch(/join\(packageRoot, 'dist'\)/)
        expect(site.buildDir).toBe(`${packageOf(site).relDir}/dist`)
      } else {
        // No `build.outDir`, so Vite writes the package's own `dist/`; if the
        // app ever moves its output, this fails rather than the deploy
        // publishing a stale copy.
        expect(readFileSync(join(dir, 'vite.config.ts'), 'utf8')).not.toMatch(/\boutDir\s*:/)
        expect(site.buildDir).toBe(`${packageOf(site).relDir}/dist`)
      }
    }
  })

  it('should require exactly the HTML entries each app declares', () => {
    // Adding or dropping an entry in the app without updating the site fails
    // here instead of publishing a site whose launch endpoint 404s.
    const declaring = APP_PAGES_SITES.flatMap((site) => {
      const dir = join(repoRoot, packageOf(site).relDir)
      const configPath = join(dir, 'vite.config.ts')
      if (!existsSync(configPath)) return []
      const config = readFileSync(configPath, 'utf8')
      const entries = [...config.matchAll(/'\.\/([\w-]+\.html)'/g)].map(([, file]) => file ?? '')
      return entries.length === 0 ? [] : [{ site, dir, entries }]
    })
    expect(declaring.length).toBeGreaterThan(5)
    for (const { site, dir, entries } of declaring) {
      expect([...site.requiredFiles].toSorted()).toEqual(entries.toSorted())
      for (const entry of entries) expect(existsSync(join(dir, entry))).toBe(true)
    }
  })

  it("should require every page of the marketing site, its CNAME and the apps' old paths", () => {
    const dir = join(repoRoot, packageOf(MARKETING_PAGES_SITE).relDir)
    const config = readFileSync(join(dir, 'vite.config.ts'), 'utf8')
    const entries = [...config.matchAll(/'([\w/-]*index\.html)'/g)].map(([, file]) => file ?? '')
    expect(entries).toContain('privacy-policy/index.html')
    expect(MARKETING_PAGES_SITE.requiredFiles).toEqual(expect.arrayContaining(entries))
    expect(MARKETING_PAGES_SITE.requiredFiles).toContain('CNAME')
    expect(existsSync(join(dir, 'public', 'CNAME'))).toBe(true)
    expect(MARKETING_PAGES_SITE.requiredFiles).toContain('health-viewer/index.html')
  })

  it('should name a Sentry DSN variable only for an app whose build reads it', () => {
    for (const site of PAGES_SITES.filter(({ sentryDsnVariable }) => sentryDsnVariable !== '')) {
      const dir = join(repoRoot, packageOf(site).relDir)
      const reads = globSync('src/**/*.{ts,tsx}', { cwd: dir }).some((file) =>
        readFileSync(join(dir, file), 'utf8').includes(`import.meta.env.${site.sentryDsnVariable}`)
      )
      expect(reads, site.name).toBe(true)
    }
  })
})

describe('pages-sites / missingRequiredFiles', () => {
  it('should report exactly the required files that do not exist', () => {
    for (const site of PAGES_SITES) {
      for (const absent of site.requiredFiles) {
        const missing = missingRequiredFiles(site, (path) => !path.endsWith(`/${absent}`))
        expect(missing).toContain(`${site.buildDir}/${absent}`)
      }
      expect(missingRequiredFiles(site, () => true)).toEqual([])
    }
  })
})

describe('pages-sites / affectedSites', () => {
  const siteNames = (sites: readonly PagesSite[]): readonly string[] =>
    sites.map(({ name }) => name).toSorted()

  it('should preview every site a change to a shared slice reaches', () => {
    // A change to branding-core reaches every site: each one depends on it.
    const affected = findAffectedPackages(
      ['slices/branding/branding-core/src/site.ts'],
      workspacePackages
    )

    expect(siteNames(affectedSites(affected, workspacePackages))).toEqual(siteNames(PAGES_SITES))
  })

  it('should preview only the app a change to its own package reaches', () => {
    const affected = findAffectedPackages(['apps/plots/plots-web/src/main.tsx'], workspacePackages)

    expect(siteNames(affectedSites(affected, workspacePackages))).toEqual(['plots'])
  })

  it('should preview no site for a change no site depends on', () => {
    const affected = findAffectedPackages(['apps/host/host-app/src/main.tsx'], workspacePackages)

    expect(affectedSites(affected, workspacePackages)).toEqual([])
  })

  it('should preview every site for a root config or unowned change', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          'pnpm-lock.yaml',
          'vite.config.base.ts',
          '.github/workflows/pr-preview.yml',
          'scripts/ci/pages-sites.ts',
          'docs/Apps/Explanation.md'
        ),
        (file) => {
          const affected = findAffectedPackages([file], workspacePackages)
          expect(siteNames(affectedSites(affected, workspacePackages))).toEqual(
            siteNames(PAGES_SITES)
          )
        }
      ),
      { numRuns: numRunsFor({ base: 10 }) }
    )
  })

  it('should preview a site whenever a change reaches its package', () => {
    fc.assert(
      fc.property(fc.subarray(workspacePackages.map(({ relDir }) => relDir)), (dirs) => {
        const affected = findAffectedPackages(
          dirs.map((dir) => `${dir}/src/x.ts`),
          workspacePackages
        )
        const previewed = new Set(
          affectedSites(affected, workspacePackages).map(({ name }) => name)
        )
        for (const site of PAGES_SITES) {
          expect(previewed.has(site.name)).toBe(affected.affected.has(site.packageName))
        }
      }),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })
})

describe('pages-sites / the deploy workflows', () => {
  const workflow = (name: string): string =>
    readFileSync(join(repoRoot, '.github', 'workflows', name), 'utf8')

  it.each(['deploy-github-pages.yml', 'pr-preview.yml'])(
    "should read only a planned site's own fields in %s",
    (name) => {
      // The matrices fan out over `pages-sites.ts plan …`, whose sites' keys
      // are the only fields a `matrix.site.<field>` can name.
      const fields = [...workflow(name).matchAll(/matrix\.site\.(\w+)/g)].map(([, field]) => field)
      expect(fields.length).toBeGreaterThan(0)
      const known: readonly string[] = Object.keys(MARKETING_PAGES_SITE)
      for (const field of fields) expect(known).toContain(field)
    }
  )

  it('should publish the 404 page branding-core holds', () => {
    const declared = /not_found_page=(\S+)/.exec(workflow('deploy-pages-site.yml'))?.[1] ?? ''
    expect(declared).toMatch(/^slices\/branding\/branding-core\//)
    expect(existsSync(join(repoRoot, declared))).toBe(true)
  })
})
