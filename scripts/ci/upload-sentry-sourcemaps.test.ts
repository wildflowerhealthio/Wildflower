import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'

// Each test runs the script against a stand-in sentry-cli (`SENTRY_CLI`) that
// logs its arguments, one call per line.
const scriptPath = join(dirname(fileURLToPath(import.meta.url)), 'upload-sentry-sourcemaps.sh')

let dir: string
let log: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'upload-sentry-sourcemaps-'))
  log = join(dir, 'calls')
  writeFileSync(
    join(dir, 'sentry-cli'),
    '#!/usr/bin/env bash\necho "$* org=$SENTRY_ORG token=$SENTRY_AUTH_TOKEN" >> "$CALLS"\n'
  )
  chmodSync(join(dir, 'sentry-cli'), 0o755)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const upload = (
  dsn: string,
  token: string
): { status: number | null; calls: readonly string[] } => {
  const result = spawnSync(
    'bash',
    [scriptPath, 'staging', 'abc123', dsn, 'apps/medications/medications-web/dist'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        SENTRY_CLI: join(dir, 'sentry-cli'),
        CALLS: log,
        SENTRY_AUTH_TOKEN: token,
        SENTRY_ORG: 'wildflower',
      },
    }
  )
  const calls = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []
  return { status: result.status, calls }
}

describe('upload-sentry-sourcemaps.sh', () => {
  it("should register the release and upload the build's maps to the DSN's project only", () => {
    const result = upload('https://key@o1.ingest.sentry.io/42', 'token')

    expect(result.status).toBe(0)
    const dist = 'apps/medications/medications-web/dist'
    expect(result.calls).toEqual(
      [
        'releases new abc123 -p 42',
        `sourcemaps inject ${dist}`,
        `sourcemaps upload -p 42 --release abc123 --ignore node_modules ${dist}`,
        'releases deploys abc123 new -e staging',
        'releases finalize abc123',
      ].map((call) => `${call} org=wildflower token=token`)
    )
  })

  it.each([
    ['no token', 'https://key@o1.ingest.sentry.io/42', ''],
    ['no DSN', '', 'token'],
  ])('should upload nothing with %s', (_, dsn, token) => {
    const result = upload(dsn, token)

    expect(result.status).toBe(0)
    expect(result.calls).toEqual([])
  })
})
