import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test'

// The script's only way out is curl, so a fake curl first on PATH plays
// Firebase and the app store: it answers by URL from FAKE_* variables and
// logs every call's arguments, one per line, calls separated by `--END--`.
const scriptPath = join(dirname(fileURLToPath(import.meta.url)), 'pebble-appstore-upload.sh')

const fakeCurl = `#!/usr/bin/env bash
out=; url=
args=("$@")
for ((i = 0; i < \${#args[@]}; i++)); do
  case "\${args[i]}" in
    --output) out="\${args[i + 1]}" ;;
    http*) url="\${args[i]}" ;;
  esac
done
{ printf '%s\\n' "$@"; echo --END--; } >> "$FAKE_LOG"
case "$url" in
  https://securetoken.googleapis.com/*) status="$FAKE_TOKEN_STATUS" body="$FAKE_TOKEN_BODY" ;;
  */api/v1/developer/me) status="$FAKE_ME_STATUS" body="$FAKE_ME_BODY" ;;
  */releases) status="$FAKE_RELEASE_STATUS" body="$FAKE_RELEASE_BODY" ;;
  *) status=404 body='{}' ;;
esac
printf '%s' "$body" > "$out"
printf '%s' "$status"
`

const uuid = 'bad5c77b-1774-4f99-a4c0-523015e43a25'
const refreshToken = 'fake-refresh-token'
const idToken = 'fake-id-token'

let dir: string

const writePbw = (appinfo: object): string => {
  writeFileSync(join(dir, 'appinfo.json'), JSON.stringify(appinfo))
  const pbw = join(dir, 'app.pbw')
  execFileSync('zip', ['-q', '-j', pbw, join(dir, 'appinfo.json')])
  return pbw
}

const me = (lookup: Record<string, string>): string =>
  JSON.stringify({ developer: { id: 'dev1' }, app_lookup: { by_app_uuid: lookup } })

const upload = (
  opts: { pbw?: string; version?: string; env?: Record<string, string> } = {}
): { status: number | null; stdout: string; stderr: string; calls: Array<Array<string>> } => {
  const log = join(dir, 'curl.log')
  writeFileSync(log, '')
  const result = spawnSync(
    'bash',
    [
      scriptPath,
      opts.pbw ?? writePbw({ uuid, versionLabel: '1.2.3', longName: 'WatchLifts' }),
      opts.version ?? '1.2.3',
    ],
    {
      encoding: 'utf8',
      env: {
        PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}`,
        HOME: dir,
        FAKE_LOG: log,
        PEBBLE_APPSTORE_REFRESH_TOKEN: refreshToken,
        RELEASE_NOTES: '- watch-lifts: first cut (#1) (abc1234)',
        FAKE_TOKEN_STATUS: '200',
        FAKE_TOKEN_BODY: JSON.stringify({
          id_token: idToken,
          refresh_token: refreshToken,
          expires_in: '3600',
        }),
        FAKE_ME_STATUS: '200',
        FAKE_ME_BODY: me({ [uuid]: 'app123' }),
        FAKE_RELEASE_STATUS: '201',
        FAKE_RELEASE_BODY: JSON.stringify({ message: 'Release created' }),
        ...opts.env,
      },
    }
  )
  const calls = readFileSync(log, 'utf8')
    .split('--END--\n')
    .filter((call) => call !== '')
    .map((call) => call.trimEnd().split('\n'))
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pebble-appstore-upload-'))
  execFileSync('mkdir', [join(dir, 'bin')])
  writeFileSync(join(dir, 'bin', 'curl'), fakeCurl)
  chmodSync(join(dir, 'bin', 'curl'), 0o755)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('pebble-appstore-upload', () => {
  it('exchanges the refresh token, finds the app and uploads a release', () => {
    const run = upload()
    expect(run.status).toBe(0)
    expect(run.calls.map((call) => call.at(-1))).toEqual([
      'https://securetoken.googleapis.com/v1/token?key=AIzaSyBZ9Cdvwwv9At2lPmc8TxyyEqSXGXejGvc',
      'https://appstore-api.repebble.com/api/v1/developer/me',
      'https://appstore-api.repebble.com/api/dashboard/apps/app123/releases',
    ])
    const release = run.calls[2] ?? []
    expect(release).toContain('version=1.2.3')
    expect(release).toContain('releaseNotes=- watch-lifts: first cut (#1) (abc1234)')
    expect(run.stdout).toContain('unpublished release')
  })

  // The whole point of not running `pebble publish`: it sends
  // isPublished=true whatever its flag says, and Ruth approves each release.
  it('uploads the release unpublished', () => {
    const release = upload().calls[2] ?? []
    expect(release).toContain('isPublished=false')
    expect(release).not.toContain('isPublished=true')
  })

  // Anything on curl's command line is readable by every process on the
  // runner, so the tokens go through files.
  it('keeps both tokens off the command line', () => {
    const flat = upload().calls.flat().join('\n')
    expect(flat).not.toContain(refreshToken)
    expect(flat).not.toContain(idToken)
  })

  it('masks the ID token under Actions, and only there', () => {
    expect(upload({ env: { GITHUB_ACTIONS: 'true' } }).stdout).toContain(`::add-mask::${idToken}`)
    expect(upload().stdout).not.toContain(idToken)
  })

  it('matches the app UUID whatever case the store keys it in', () => {
    const run = upload({ env: { FAKE_ME_BODY: me({ [uuid.toUpperCase()]: 'app123' }) } })
    expect(run.status).toBe(0)
    expect(run.calls[2]?.at(-1)).toContain('/apps/app123/releases')
  })

  // `pebble publish --non-interactive` would create the listing here, with
  // an AI-generated icon and whatever description a flag carried. CI must
  // stop and leave the first upload to a person.
  it('fails without creating anything when the store has no listing', () => {
    const run = upload({ env: { FAKE_ME_BODY: me({ 'other-uuid': 'app999' }) } })
    expect(run.status).toBe(1)
    expect(run.stderr).toContain(`no app with UUID ${uuid}`)
    expect(run.stderr).toContain('by hand')
    expect(run.calls).toHaveLength(2)
  })

  it('fails without creating a developer account when none is linked', () => {
    const run = upload({
      env: {
        FAKE_ME_STATUS: '403',
        FAKE_ME_BODY: JSON.stringify({ code: 'DEVELOPER_NOT_LINKED' }),
      },
    })
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('no Pebble developer account')
    expect(run.calls).toHaveLength(2)
  })

  it('names the Firebase error when the refresh token is refused', () => {
    const run = upload({
      env: {
        FAKE_TOKEN_STATUS: '400',
        FAKE_TOKEN_BODY: JSON.stringify({ error: { code: 400, message: 'INVALID_REFRESH_TOKEN' } }),
      },
    })
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('HTTP 400: INVALID_REFRESH_TOKEN')
    expect(run.calls).toHaveLength(1)
  })

  it('reports the store refusing the release', () => {
    const run = upload({
      env: {
        FAKE_RELEASE_STATUS: '409',
        FAKE_RELEASE_BODY: JSON.stringify({ error: 'Version exists' }),
      },
    })
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('(HTTP 409): Version exists')
  })

  it('refuses a .pbw built for another version before calling out', () => {
    const run = upload({ version: '1.2.4' })
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('is version 1.2.3, not 1.2.4')
    expect(run.calls).toHaveLength(0)
  })

  it('refuses an uppercase UUID, which pebble publish would have lowercased', () => {
    const pbw = writePbw({ uuid: uuid.toUpperCase(), versionLabel: '1.2.3' })
    const run = upload({ pbw })
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('uppercase')
    expect(run.calls).toHaveLength(0)
  })

  it('fails when the secret is empty', () => {
    const run = upload({ env: { PEBBLE_APPSTORE_REFRESH_TOKEN: '' } })
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('PEBBLE_APPSTORE_REFRESH_TOKEN is empty')
    expect(run.calls).toHaveLength(0)
  })
})
