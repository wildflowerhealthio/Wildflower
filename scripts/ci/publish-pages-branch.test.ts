import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'

// Each test publishes into a bare repository standing in for an app's Pages
// repository, and reads back the files its `gh-pages` branch holds.
const scriptPath = join(dirname(fileURLToPath(import.meta.url)), 'publish-pages-branch.sh')

let dir: string
let remote: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'publish-pages-branch-'))
  remote = join(dir, 'pages.git')
  execFileSync('git', ['init', '-q', '--bare', remote])
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Write a site build of `files` (path → contents) and return its directory. */
const build = (name: string, files: Readonly<Record<string, string>>): string => {
  const root = join(dir, name)
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), contents)
  }
  return root
}

const notFoundPage = (contents: string): string => {
  const path = join(dir, `404-${contents}.html`)
  writeFileSync(path, contents)
  return path
}

const env = (): NodeJS.ProcessEnv => ({
  ...process.env,
  PAGES_REMOTE: remote,
  PAGES_BRANCH: 'gh-pages',
  PAGES_COMMIT_MESSAGE: 'Deploy under test',
})

const publish = (...args: string[]): { status: number | null; output: string } => {
  const result = spawnSync('bash', [scriptPath, ...args], { encoding: 'utf8', env: env() })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

const publishAsync = (...args: string[]): Promise<number | null> =>
  new Promise((resolve) => {
    spawn('bash', [scriptPath, ...args], { env: env(), stdio: 'ignore' }).on('exit', resolve)
  })

const git = (...args: string[]): string =>
  execFileSync('git', ['--git-dir', remote, ...args], { encoding: 'utf8' }).trim()

/** Every file on the branch, sorted. */
const branchFiles = (): readonly string[] =>
  git('ls-tree', '-r', '--name-only', 'gh-pages').split('\n').filter(Boolean).toSorted()

const branchFile = (path: string): string => git('show', `gh-pages:${path}`)

const app = { 'index.html': 'app', 'assets/app.js': 'js' }

describe('publish-pages-branch.sh', () => {
  it('should publish production at the root with its CNAME, .nojekyll and 404.html', () => {
    const result = publish(
      'production',
      build('build', app),
      'medications.wildflowerhealth.io',
      notFoundPage('404')
    )

    expect(result.status).toBe(0)
    expect(branchFiles()).toEqual(
      ['.nojekyll', '404.html', 'CNAME', 'assets/app.js', 'index.html'].toSorted()
    )
    expect(branchFile('CNAME')).toBe('medications.wildflowerhealth.io')
    expect(branchFile('404.html')).toBe('404')
  })

  it('should publish a preview under pr-<n>/ without a CNAME, leaving production alone', () => {
    publish('production', build('prod', app), 'medications.wildflowerhealth.io', notFoundPage('a'))

    const result = publish(
      'preview',
      '7',
      build('preview', { ...app, 'index.html': 'preview', CNAME: 'wildflowerhealth.io' }),
      notFoundPage('b')
    )

    expect(result.status).toBe(0)
    expect(branchFiles()).toEqual(
      [
        '.nojekyll',
        '404.html',
        'CNAME',
        'assets/app.js',
        'index.html',
        'pr-7/assets/app.js',
        'pr-7/index.html',
      ].toSorted()
    )
    expect(branchFile('index.html')).toBe('app')
    expect(branchFile('pr-7/index.html')).toBe('preview')
    // The preview's own 404 page never replaces production's.
    expect(branchFile('404.html')).toBe('a')
  })

  it('should give a preview on a branch with no site a root 404.html and .nojekyll', () => {
    const result = publish('preview', '7', build('preview', app), notFoundPage('404'))

    expect(result.status).toBe(0)
    expect(branchFiles()).toEqual(
      ['.nojekyll', '404.html', 'pr-7/assets/app.js', 'pr-7/index.html'].toSorted()
    )
  })

  it('should keep every preview through a production deploy, and drop stale production files', () => {
    publish('production', build('one', { ...app, 'old.js': 'old' }), 'x.example', notFoundPage('a'))
    publish('preview', '7', build('seven', app), notFoundPage('a'))
    publish('preview', '12', build('twelve', app), notFoundPage('a'))

    const result = publish('production', build('two', app), 'x.example', notFoundPage('b'))

    expect(result.status).toBe(0)
    expect(branchFiles()).toEqual(
      [
        '.nojekyll',
        '404.html',
        'CNAME',
        'assets/app.js',
        'index.html',
        'pr-12/assets/app.js',
        'pr-12/index.html',
        'pr-7/assets/app.js',
        'pr-7/index.html',
      ].toSorted()
    )
    expect(branchFile('404.html')).toBe('b')
  })

  it('should keep the branch to one parentless commit', () => {
    publish('production', build('prod', app), 'x.example', notFoundPage('a'))
    publish('preview', '7', build('preview', app), notFoundPage('a'))

    expect(git('rev-list', '--count', 'gh-pages')).toBe('1')
    expect(git('log', '-1', '--format=%s', 'gh-pages')).toBe('Deploy under test')
  })

  it('should tear down only its own preview', () => {
    publish('production', build('prod', app), 'x.example', notFoundPage('a'))
    publish('preview', '7', build('seven', app), notFoundPage('a'))
    publish('preview', '12', build('twelve', app), notFoundPage('a'))

    const result = publish('teardown', '7')

    expect(result.status).toBe(0)
    expect(branchFiles().filter((file) => file.startsWith('pr-'))).toEqual([
      'pr-12/assets/app.js',
      'pr-12/index.html',
    ])
  })

  it('should succeed without pushing when there is nothing to tear down', () => {
    expect(publish('teardown', '7').status).toBe(0)
    publish('production', build('prod', app), 'x.example', notFoundPage('a'))
    const before = git('rev-parse', 'gh-pages')

    expect(publish('teardown', '7').status).toBe(0)
    expect(git('rev-parse', 'gh-pages')).toBe(before)
  })

  it('should keep every concurrent deploy, retrying a push that lost its lease', async () => {
    // Arrange — production plus three previews, all published at once.
    const notFound = notFoundPage('a')
    const deploys = [
      publishAsync('production', build('prod', app), 'x.example', notFound),
      ...['1', '2', '3'].map((pr) => publishAsync('preview', pr, build(`pr${pr}`, app), notFound)),
    ]

    // Act
    const statuses = await Promise.all(deploys)

    // Assert — whichever order the pushes landed in, every part survived.
    expect(statuses).toEqual([0, 0, 0, 0])
    expect(branchFiles()).toEqual(
      expect.arrayContaining([
        'index.html',
        'pr-1/index.html',
        'pr-2/index.html',
        'pr-3/index.html',
      ])
    )
  }, 60_000)

  it('should refuse a PR number that is not one', () => {
    const result = publish('preview', '../x', build('preview', app), notFoundPage('a'))

    expect(result.status).toBe(1)
    expect(result.output).toContain('Not a PR number')
  })

  it('should refuse a production build with an entry a preview would be taken for', () => {
    const result = publish(
      'production',
      build('prod', { ...app, 'pr-3/index.html': 'x' }),
      'x.example',
      notFoundPage('a')
    )

    expect(result.status).toBe(1)
    expect(result.output).toContain('would be taken for a preview')
  })

  it('should refuse a build without an index.html', () => {
    const result = publish('preview', '7', build('empty', { 'a.js': 'x' }), notFoundPage('a'))

    expect(result.status).toBe(1)
    expect(result.output).toContain('has no index.html')
  })
})
