import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FileSystem, Path } from '@effect/platform'
import { NodeFileSystem, NodePath } from '@effect/platform-node'
import { Effect, Layer, Option } from 'effect'
import * as fc from 'fast-check'
import { afterEach, beforeEach, expect, test } from 'vite-plus/test'
import { sanitizeRequestPath, tryFindAssetFileForPath } from '../src/static-spa.ts'

const FsLayer = Layer.merge(NodeFileSystem.layer, NodePath.layer)

const runFsEffect = <A>(
  effect: Effect.Effect<A, never, FileSystem.FileSystem | Path.Path>
): Promise<A> => Effect.runPromise(Effect.provide(effect, FsLayer))

let tempBase: string

beforeEach(() => {
  tempBase = mkdtempSync(join(tmpdir(), 'static-spa-test-'))
})

afterEach(() => {
  rmSync(tempBase, { recursive: true, force: true })
})

test('sanitizeRequestPath returns Option.some for the SPA root', () => {
  expect(sanitizeRequestPath('')).toEqual(Option.some(''))
  expect(sanitizeRequestPath('/')).toEqual(Option.some(''))
})

test('sanitizeRequestPath returns Option.some for a normal asset', () => {
  expect(sanitizeRequestPath('/assets/app.js')).toEqual(Option.some('assets/app.js'))
  expect(sanitizeRequestPath('/favicon.ico')).toEqual(Option.some('favicon.ico'))
})

test('sanitizeRequestPath rejects literal parent-directory traversal', () => {
  expect(sanitizeRequestPath('/../etc/passwd')).toEqual(Option.none())
  expect(sanitizeRequestPath('../etc/passwd')).toEqual(Option.none())
  expect(sanitizeRequestPath('/foo/../../etc/passwd')).toEqual(Option.none())
})

test('sanitizeRequestPath rejects percent-encoded parent-directory traversal', () => {
  expect(sanitizeRequestPath('/%2E%2E/etc/passwd')).toEqual(Option.none())
  expect(sanitizeRequestPath('/%2e%2e/etc/passwd')).toEqual(Option.none())
  expect(sanitizeRequestPath('/foo/%2e./etc')).toEqual(Option.none())
})

test('sanitizeRequestPath rejects malformed percent-encoding', () => {
  expect(sanitizeRequestPath('/foo%')).toEqual(Option.none())
})

test('sanitizeRequestPath rejects null-byte injection', () => {
  expect(sanitizeRequestPath('/assets/app\0.js')).toEqual(Option.none())
})

test('sanitizeRequestPath collapses multiple leading slashes', () => {
  expect(sanitizeRequestPath('//assets//app.js')).toEqual(Option.some('assets/app.js'))
})

test('sanitizeRequestPath passes deep-link routes through', () => {
  expect(sanitizeRequestPath('/gatekeeper/requests')).toEqual(Option.some('gatekeeper/requests'))
})

test('sanitizeRequestPath: %2f-encoded slash variants stay encoded in the relative path', () => {
  // `URL.pathname` keeps `%2f` encoded; the FS-side containment check catches the escape.
  const result = sanitizeRequestPath('/foo%2f..%2fetc/passwd')
  expect(Option.isSome(result)).toBe(true)
})

test('sanitizeRequestPath: backslash-encoded escapes stay literal', () => {
  // Backslashes aren't parent segments; FS-side containment check enforces base-dir.
  const result = sanitizeRequestPath('/foo\\..\\etc/passwd')
  expect(Option.isSome(result)).toBe(true)
})

test('sanitizeRequestPath property: every Some(rel) is a safe relative path', () => {
  fc.assert(
    fc.property(fc.string(), (input) => {
      const result = sanitizeRequestPath(input)
      if (Option.isNone(result)) return
      const rel = result.value
      expect(rel.startsWith('/')).toBe(false)
      expect(rel).not.toContain('\0')
      const segments = rel.split('/')
      for (const seg of segments) expect(seg).not.toBe('..')
    }),
    { numRuns: 200 }
  )
})

test('tryFindAssetFileForPath returns Some when a real file exists at the candidate', async () => {
  writeFileSync(join(tempBase, 'app.js'), 'console.log(1)')
  const result = await runFsEffect(tryFindAssetFileForPath(tempBase, 'app.js'))
  expect(Option.isSome(result)).toBe(true)
  if (Option.isSome(result)) {
    expect(result.value).toBe(join(tempBase, 'app.js'))
  }
})

test('tryFindAssetFileForPath returns None for a directory at the candidate', async () => {
  mkdirSync(join(tempBase, 'assets'))
  const result = await runFsEffect(tryFindAssetFileForPath(tempBase, 'assets'))
  expect(result).toEqual(Option.none())
})

test('tryFindAssetFileForPath returns None when the file is missing', async () => {
  const result = await runFsEffect(tryFindAssetFileForPath(tempBase, 'nope.js'))
  expect(result).toEqual(Option.none())
})

test('tryFindAssetFileForPath rejects symlinked traversal escape', async () => {
  // Symlinks under the base ARE followed: `path.resolve` doesn't expand them, so the
  // candidate stays textually under tempBase. Documents the gap — deployers must
  // not place attacker-controlled symlinks under web-assets.
  const escapeTarget = mkdtempSync(join(tmpdir(), 'static-spa-escape-'))
  try {
    writeFileSync(join(escapeTarget, 'secret.txt'), 'sensitive')
    symlinkSync(escapeTarget, join(tempBase, 'link'))
    const result = await runFsEffect(tryFindAssetFileForPath(tempBase, 'link/secret.txt'))
    expect(Option.isSome(result)).toBe(true)
  } finally {
    rmSync(escapeTarget, { recursive: true, force: true })
  }
})

test('tryFindAssetFileForPath rejects an absolute relPath that escapes via path.resolve', async () => {
  // `path.resolve(base, '/etc/passwd')` returns `/etc/passwd` — the absolute argument wins.
  const result = await runFsEffect(tryFindAssetFileForPath(tempBase, '/etc/passwd'))
  expect(result).toEqual(Option.none())
})

test('tryFindAssetFileForPath rejects path.resolve escapes via embedded ..', async () => {
  const result = await runFsEffect(tryFindAssetFileForPath(tempBase, '../escape'))
  expect(result).toEqual(Option.none())
})

test('tryFindAssetFileForPath property: returned path always lives under webAssetsDir', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc
        .string()
        .filter((s) => !s.includes('\0'))
        .map((s) => s.slice(0, 50)),
      async (relPath) => {
        const result = await runFsEffect(tryFindAssetFileForPath(tempBase, relPath))
        if (Option.isNone(result)) return
        expect(result.value.startsWith(tempBase)).toBe(true)
      }
    ),
    { numRuns: 50 }
  )
})
