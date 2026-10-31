import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'

import { MARKETING_PAGES_SITE, type PagesSite } from './pages-sites.ts'

// Each test publishes into bare repositories under a directory standing in
// for github.com/wildflowerhealthio (`PAGES_REMOTE_BASE`), one per site's
// Pages repository, and reads back what their branches hold.
const ciDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(ciDir, '..', '..')
const scriptPath = join(ciDir, 'deploy-pages-sites.sh')

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'deploy-pages-sites-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** A planned site whose build is `buildDir` and whose Pages repository is `<name>-web`. */
const site = (name: string, buildDir: string): PagesSite => ({
  ...MARKETING_PAGES_SITE,
  name,
  buildDir,
  pagesRepository: `${name}-web`,
  pagesBranch: 'gh-pages',
  siteUrl: `https://${name}.wildflowerhealth.io/`,
  includesBook: false,
})

/** A Pages repository for `name`, and a build holding an `index.html` of `contents`. */
const siteWithBuild = (name: string, contents: string): PagesSite => {
  execFileSync('git', ['init', '-q', '--bare', join(dir, `${name}-web.git`)])
  const build = join(dir, `${name}-build`)
  mkdirSync(build)
  writeFileSync(join(build, 'index.html'), contents)
  return site(name, build)
}

const run = (
  mode: string,
  sites: readonly PagesSite[],
  target: string
): { status: number | null; output: string; outputs: string } => {
  const outputFile = join(dir, 'github-output')
  writeFileSync(outputFile, '')
  const result = spawnSync('bash', [scriptPath, mode], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      SITES: JSON.stringify(sites),
      TARGET: target,
      RELEASE: 'abc123',
      GITHUB_REPOSITORY: 'wildflowerhealthio/Wildflower',
      GITHUB_OUTPUT: outputFile,
      PAGES_REMOTE_BASE: dir,
    },
  })
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
    outputs: readFileSync(outputFile, 'utf8'),
  }
}

const git = (name: string, ...args: string[]): string =>
  execFileSync('git', ['--git-dir', join(dir, `${name}-web.git`), ...args], {
    encoding: 'utf8',
  }).trim()

const branchFiles = (name: string): readonly string[] =>
  git(name, 'ls-tree', '-r', '--name-only', 'gh-pages').split('\n').filter(Boolean).toSorted()

describe('deploy-pages-sites.sh', () => {
  it("should publish every site's preview after one fails, naming the failure", () => {
    const sites = [
      siteWithBuild('medications', 'medications'),
      site('broken', join(dir, 'missing-build')),
      siteWithBuild('plots', 'plots'),
    ]

    const result = run('publish', sites, '12')

    expect(result.status).toBe(0)
    expect(result.output).toContain('::error::Publish broken failed')
    expect(result.outputs).toBe('failed=broken\n')
    for (const name of ['medications', 'plots']) {
      expect(git(name, 'show', 'gh-pages:pr-12/index.html')).toBe(name)
      expect(git(name, 'log', '-1', '--format=%s', 'gh-pages')).toBe(
        'Deploy wildflowerhealthio/Wildflower@abc123 (pr-12)'
      )
    }
  })

  it('should publish production at the root under the custom domain', () => {
    const result = run('publish', [siteWithBuild('medications', 'medications')], 'production')

    expect(result.status).toBe(0)
    expect(result.outputs).toBe('failed=\n')
    expect(git('medications', 'show', 'gh-pages:CNAME')).toBe('medications.wildflowerhealth.io')
    expect(git('medications', 'show', 'gh-pages:index.html')).toBe('medications')
  })

  it('should remove every preview it can, then fail naming the rest', () => {
    const sites = [siteWithBuild('medications', 'medications'), siteWithBuild('plots', 'plots')]
    expect(run('publish', sites, '12').status).toBe(0)

    const result = run('teardown', [site('gone', dir), ...sites], '12')

    expect(result.status).toBe(1)
    expect(result.output).toContain('::error::Could not remove the previews of: gone')
    for (const name of ['medications', 'plots']) {
      expect(branchFiles(name)).toEqual(['.nojekyll', '404.html'])
    }
  })

  it('should refuse a target that is neither production nor a PR number', () => {
    const result = run('publish', [], 'pr-12')

    expect(result.status).toBe(1)
    expect(result.output).toContain('Not production or a PR number: pr-12')
  })
})
