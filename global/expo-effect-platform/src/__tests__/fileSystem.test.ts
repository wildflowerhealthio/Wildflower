import * as PlatformError from '@effect/platform/Error'
import * as FileSystem from '@effect/platform/FileSystem'
import * as Server from '@effect/platform/HttpServer'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import { pipe } from 'effect/Function'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Stream from 'effect/Stream'
import * as fc from 'fast-check'

// Stub the TurboModule so Jest can resolve the module graph; nothing in this test file calls into the native side.
jest.mock('../ExpoEffectPlatformModule', () => ({
  __esModule: true,
  default: {},
}))

// `jest.mock` is hoisted above imports, so per-test state lives on module-level maps reset in beforeEach.
type FileEntry = { kind: 'file'; bytes: Uint8Array; modificationTime: number | null }
type DirEntry = { kind: 'dir'; size: number | null }
type FsEntry = FileEntry | DirEntry
const MOCK_FS = new Map<string, FsEntry>()

const stripScheme = (uri: string): string => uri.replace(/^file:\/\//, '')

jest.mock('expo-file-system', () => {
  // Module-local helper bound to the closure of MOCK_FS (the jest.mock factory
  // is hoisted above the `MOCK_FS` declaration, but the function bodies are
  // not evaluated until tests run, so the reference resolves at call time).
  const getEntry = (uri: string): FsEntry | undefined => MOCK_FS.get(stripScheme(uri))
  class MockFile {
    readonly uri: string
    constructor(uri: string) {
      this.uri = uri
    }
    get exists(): boolean {
      const entry = getEntry(this.uri)
      return entry?.kind === 'file'
    }
    get size(): number {
      const entry = getEntry(this.uri)
      return entry?.kind === 'file' ? entry.bytes.byteLength : 0
    }
    get modificationTime(): number | null {
      const entry = getEntry(this.uri)
      return entry?.kind === 'file' ? entry.modificationTime : null
    }
    get creationTime(): number | null {
      return null
    }
    create(options?: { intermediates?: boolean; overwrite?: boolean }): void {
      const path = stripScheme(this.uri)
      const existing = MOCK_FS.get(path)
      if (existing !== undefined) {
        if (options?.overwrite) {
          // Mirror expo-file-system: overwrite collapses to "create fresh,
          // discarding prior contents."
          MOCK_FS.set(path, { kind: 'file', bytes: new Uint8Array(), modificationTime: null })
          return
        }
        throw new Error(`File already exists at ${path}`)
      }
      MOCK_FS.set(path, { kind: 'file', bytes: new Uint8Array(), modificationTime: null })
    }
    delete(): void {
      const path = stripScheme(this.uri)
      if (!MOCK_FS.has(path)) {
        throw new Error(`No such file at ${path}`)
      }
      MOCK_FS.delete(path)
    }
    write(content: string | Uint8Array): void {
      const path = stripScheme(this.uri)
      const entry = MOCK_FS.get(path)
      if (entry?.kind !== 'file') {
        throw new Error(`No such file at ${path}`)
      }
      const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content
      MOCK_FS.set(path, { kind: 'file', bytes, modificationTime: entry.modificationTime })
    }
    bytesSync(): Uint8Array {
      const path = stripScheme(this.uri)
      const entry = MOCK_FS.get(path)
      if (entry?.kind !== 'file') {
        throw new Error(`No such file at ${path}`)
      }
      return entry.bytes
    }
  }
  class MockDirectory {
    readonly uri: string
    constructor(uri: string) {
      this.uri = uri
    }
    get exists(): boolean {
      return getEntry(this.uri)?.kind === 'dir'
    }
    get size(): number | null {
      const entry = getEntry(this.uri)
      return entry?.kind === 'dir' ? entry.size : null
    }
    create(options?: { intermediates?: boolean; idempotent?: boolean }): void {
      const path = stripScheme(this.uri)
      const existing = MOCK_FS.get(path)
      if (existing !== undefined) {
        if (options?.idempotent && existing.kind === 'dir') return
        throw new Error(`Already exists at ${path}`)
      }
      MOCK_FS.set(path, { kind: 'dir', size: 0 })
    }
    delete(): void {
      const path = stripScheme(this.uri)
      if (!MOCK_FS.has(path)) {
        throw new Error(`No such directory at ${path}`)
      }
      MOCK_FS.delete(path)
    }
  }
  const Paths = {
    get cache(): MockDirectory {
      return new MockDirectory('file:///mock-cache')
    },
    info(uri: string): { exists: boolean; isDirectory: boolean | null } {
      const entry = getEntry(uri)
      if (entry === undefined) return { exists: false, isDirectory: null }
      return { exists: true, isDirectory: entry.kind === 'dir' }
    },
  }
  return { __esModule: true, File: MockFile, Directory: MockDirectory, Paths }
})

import type * as ExpoFileSystemModule from '../ExpoFileSystem.ts'

// `require` (not `import`) matches sibling test files where mock factories
// capture module-local variables that ES imports would race against.
// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
const ExpoFileSystem = require('../ExpoFileSystem') as typeof ExpoFileSystemModule

const stage = (path: string, entry: FsEntry): void => {
  MOCK_FS.set(path, entry)
}

const runFs = <A, E>(body: (fs: FileSystem.FileSystem) => Effect.Effect<A, E>): Promise<A> => {
  const program = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* body(fs)
  }).pipe(Effect.provide(ExpoFileSystem.layer))
  return Effect.runPromise(program)
}

const expectFailureCause = async <A, E>(eff: Effect.Effect<A, E>): Promise<E> => {
  const exit = await Effect.runPromiseExit(eff)
  return pipe(exit, Exit.causeOption, Option.flatMap(Cause.failureOption), Option.getOrThrow)
}

beforeEach(() => {
  MOCK_FS.clear()
})

// ---------------------------------------------------------------------------
// Tests: ExpoFileSystem
// ---------------------------------------------------------------------------

describe('ExpoFileSystem', () => {
  describe('access / exists', () => {
    test('exists returns true for an existing file', async () => {
      stage('/cache/x.txt', {
        kind: 'file',
        bytes: new TextEncoder().encode('hi'),
        modificationTime: null,
      })
      await runFs((fs) =>
        Effect.gen(function* () {
          expect(yield* fs.exists('/cache/x.txt')).toBe(true)
        })
      )
    })

    test('exists returns true for an existing directory', async () => {
      stage('/cache/dir', { kind: 'dir', size: 0 })
      await runFs((fs) =>
        Effect.gen(function* () {
          expect(yield* fs.exists('/cache/dir')).toBe(true)
        })
      )
    })

    test('exists returns false for a missing path', async () => {
      await runFs((fs) =>
        Effect.gen(function* () {
          expect(yield* fs.exists('/cache/missing')).toBe(false)
        })
      )
    })

    test('access fails with NotFound when path is missing', async () => {
      const error = await expectFailureCause(
        Effect.flatMap(FileSystem.FileSystem, (fs) => fs.access('/cache/missing')).pipe(
          Effect.provide(ExpoFileSystem.layer)
        )
      )
      expect(error).toMatchObject({
        _tag: 'SystemError',
        reason: 'NotFound',
        pathOrDescriptor: '/cache/missing',
      })
    })
  })

  describe('makeDirectory', () => {
    test('creates a directory and is idempotent under recursive', async () => {
      await runFs((fs) =>
        Effect.gen(function* () {
          yield* fs.makeDirectory('/cache/new', { recursive: true })
          expect(yield* fs.exists('/cache/new')).toBe(true)
          // Second call must not throw — `recursive: true` maps to both
          // `intermediates` and `idempotent` on expo-file-system.
          yield* fs.makeDirectory('/cache/new', { recursive: true })
          expect(yield* fs.exists('/cache/new')).toBe(true)
        })
      )
    })

    test('non-recursive create on an existing directory fails with AlreadyExists', async () => {
      stage('/cache/exists', { kind: 'dir', size: 0 })
      const error = await expectFailureCause(
        Effect.flatMap(FileSystem.FileSystem, (fs) => fs.makeDirectory('/cache/exists')).pipe(
          Effect.provide(ExpoFileSystem.layer)
        )
      )
      expect(error).toMatchObject({
        _tag: 'SystemError',
        reason: 'AlreadyExists',
        pathOrDescriptor: '/cache/exists',
      })
    })

    test('non-recursive create on an existing file path fails with AlreadyExists', async () => {
      stage('/cache/file.txt', {
        kind: 'file',
        bytes: new Uint8Array(),
        modificationTime: null,
      })
      const error = await expectFailureCause(
        Effect.flatMap(FileSystem.FileSystem, (fs) => fs.makeDirectory('/cache/file.txt')).pipe(
          Effect.provide(ExpoFileSystem.layer)
        )
      )
      expect(error).toMatchObject({
        _tag: 'SystemError',
        reason: 'AlreadyExists',
        pathOrDescriptor: '/cache/file.txt',
      })
    })
  })

  describe('writeFileString / readFileString round-trip', () => {
    test('write then read returns the same string', async () => {
      await fc.assert(
        fc.asyncProperty(fc.string(), async (data) => {
          MOCK_FS.clear()
          await runFs((fs) =>
            Effect.gen(function* () {
              yield* fs.makeDirectory('/cache/wf', { recursive: true })
              yield* fs.writeFileString('/cache/wf/index.html', data)
              expect(yield* fs.readFileString('/cache/wf/index.html')).toBe(data)
            })
          )
        }),
        { numRuns: 25 }
      )
    })

    test('write overwrites an existing file', async () => {
      await runFs((fs) =>
        Effect.gen(function* () {
          yield* fs.writeFileString('/cache/idx.html', 'first')
          yield* fs.writeFileString('/cache/idx.html', 'second')
          expect(yield* fs.readFileString('/cache/idx.html')).toBe('second')
        })
      )
    })
  })

  describe('writeFile / readFile (Uint8Array path)', () => {
    test('byte-level round trip', async () => {
      await fc.assert(
        fc.asyncProperty(fc.uint8Array(), async (data) => {
          MOCK_FS.clear()
          await runFs((fs) =>
            Effect.gen(function* () {
              yield* fs.writeFile('/cache/bytes.bin', data)
              const read = yield* fs.readFile('/cache/bytes.bin')
              expect(read).toEqual(data)
            })
          )
        }),
        { numRuns: 25 }
      )
    })

    test('stat.size matches the written byteLength', async () => {
      await fc.assert(
        fc.asyncProperty(fc.uint8Array(), async (data) => {
          MOCK_FS.clear()
          await runFs((fs) =>
            Effect.gen(function* () {
              yield* fs.writeFile('/cache/sized.bin', data)
              const info = yield* fs.stat('/cache/sized.bin')
              expect(Number(info.size)).toBe(data.byteLength)
            })
          )
        }),
        { numRuns: 25 }
      )
    })

    test('non-default flag is rejected with a typed SystemError', async () => {
      const error = await expectFailureCause(
        Effect.flatMap(FileSystem.FileSystem, (fs) =>
          fs.writeFile('/cache/append.bin', new Uint8Array([1, 2, 3]), { flag: 'a' })
        ).pipe(Effect.provide(ExpoFileSystem.layer))
      )
      expect(error).toMatchObject({
        _tag: 'SystemError',
        reason: 'BadResource',
        pathOrDescriptor: '/cache/append.bin',
      })
    })
  })

  describe('remove', () => {
    test('remove deletes an existing file', async () => {
      stage('/cache/old.txt', {
        kind: 'file',
        bytes: new TextEncoder().encode('x'),
        modificationTime: null,
      })
      await runFs((fs) =>
        Effect.gen(function* () {
          yield* fs.remove('/cache/old.txt')
          expect(yield* fs.exists('/cache/old.txt')).toBe(false)
        })
      )
    })

    test('remove deletes an existing directory', async () => {
      stage('/cache/old', { kind: 'dir', size: 0 })
      await runFs((fs) =>
        Effect.gen(function* () {
          yield* fs.remove('/cache/old', { recursive: true })
          expect(yield* fs.exists('/cache/old')).toBe(false)
        })
      )
    })

    test('remove on missing path with force is a no-op', async () => {
      await runFs((fs) =>
        Effect.gen(function* () {
          yield* fs.remove('/cache/never-existed', { force: true })
        })
      )
    })

    test('remove on missing path without force fails with NotFound', async () => {
      const error = await expectFailureCause(
        Effect.flatMap(FileSystem.FileSystem, (fs) => fs.remove('/cache/missing')).pipe(
          Effect.provide(ExpoFileSystem.layer)
        )
      )
      expect(error).toMatchObject({
        _tag: 'SystemError',
        reason: 'NotFound',
        pathOrDescriptor: '/cache/missing',
      })
    })
  })

  describe('stat', () => {
    test('stat on a file returns type: File with size and mtime', async () => {
      const bytes = new TextEncoder().encode('hello world')
      stage('/cache/known.txt', { kind: 'file', bytes, modificationTime: 0xabc })
      await runFs((fs) =>
        Effect.gen(function* () {
          const info = yield* fs.stat('/cache/known.txt')
          expect(info.type).toBe('File')
          expect(Number(info.size)).toBe(bytes.byteLength)
          expect(Option.getOrNull(info.mtime)).toEqual(new Date(0xabc))
        })
      )
    })

    test('stat on a directory returns type: Directory', async () => {
      stage('/cache/dir', { kind: 'dir', size: 42 })
      await runFs((fs) =>
        Effect.gen(function* () {
          const info = yield* fs.stat('/cache/dir')
          expect(info.type).toBe('Directory')
          expect(Number(info.size)).toBe(42)
        })
      )
    })

    test('stat on a directory whose size is null surfaces PermissionDenied', async () => {
      // expo-file-system's docs call out `Directory.size === null` as
      // "unreadable" (e.g. permission failure). It must not silently
      // coalesce to `size: 0` — exercising the explicit failure branch.
      stage('/cache/sealed', { kind: 'dir', size: null })
      const error = await expectFailureCause(
        Effect.flatMap(FileSystem.FileSystem, (fs) => fs.stat('/cache/sealed')).pipe(
          Effect.provide(ExpoFileSystem.layer)
        )
      )
      expect(error).toMatchObject({
        _tag: 'SystemError',
        reason: 'PermissionDenied',
        pathOrDescriptor: '/cache/sealed',
      })
    })

    test('stat on missing path fails with NotFound', async () => {
      const error = await expectFailureCause(
        Effect.flatMap(FileSystem.FileSystem, (fs) => fs.stat('/cache/missing')).pipe(
          Effect.provide(ExpoFileSystem.layer)
        )
      )
      expect(error).toMatchObject({
        _tag: 'SystemError',
        reason: 'NotFound',
        pathOrDescriptor: '/cache/missing',
      })
    })
  })

  describe('unsupported operations', () => {
    test.each([
      ['chmod', (fs: FileSystem.FileSystem) => fs.chmod('/cache/x', 0o644)],
      ['chown', (fs: FileSystem.FileSystem) => fs.chown('/cache/x', 0, 0)],
      ['copy', (fs: FileSystem.FileSystem) => fs.copy('/cache/x', '/cache/y')],
      ['copyFile', (fs: FileSystem.FileSystem) => fs.copyFile('/cache/x', '/cache/y')],
      ['link', (fs: FileSystem.FileSystem) => fs.link('/cache/x', '/cache/y')],
      ['makeTempDirectory', (fs: FileSystem.FileSystem) => fs.makeTempDirectory()],
      ['makeTempFile', (fs: FileSystem.FileSystem) => fs.makeTempFile()],
      ['open', (fs: FileSystem.FileSystem) => Effect.scoped(fs.open('/cache/x'))],
      ['readDirectory', (fs: FileSystem.FileSystem) => fs.readDirectory('/cache')],
      ['readLink', (fs: FileSystem.FileSystem) => fs.readLink('/cache/x')],
      ['realPath', (fs: FileSystem.FileSystem) => fs.realPath('/cache/x')],
      ['rename', (fs: FileSystem.FileSystem) => fs.rename('/cache/x', '/cache/y')],
      ['symlink', (fs: FileSystem.FileSystem) => fs.symlink('/cache/x', '/cache/y')],
      ['truncate', (fs: FileSystem.FileSystem) => fs.truncate('/cache/x')],
      ['utimes', (fs: FileSystem.FileSystem) => fs.utimes('/cache/x', new Date(), new Date())],
    ])('%s fails with reason BadResource', async (_label, call) => {
      const error = await expectFailureCause(
        Effect.flatMap(FileSystem.FileSystem, (fs) => call(fs)).pipe(
          Effect.provide(ExpoFileSystem.layer)
        )
      )
      expect(error).toBeInstanceOf(PlatformError.SystemError)
      expect(error).toMatchObject({ _tag: 'SystemError', reason: 'BadResource' })
    })

    test('watch fails with reason BadResource (routed via Stream.fail)', async () => {
      // `watch` returns a `Stream`, not an `Effect`, so it never hits the
      // `Effect.fail` path the rest of the unsupported methods use. Drain
      // the stream into an Effect to capture the typed failure.
      const error = await expectFailureCause(
        Effect.flatMap(FileSystem.FileSystem, (fs) => Stream.runDrain(fs.watch('/cache/x'))).pipe(
          Effect.provide(ExpoFileSystem.layer)
        )
      )
      expect(error).toBeInstanceOf(PlatformError.SystemError)
      expect(error).toMatchObject({ _tag: 'SystemError', reason: 'BadResource' })
    })
  })

  describe('ExpoCacheDir', () => {
    test('resolves to the Paths.cache uri with file:// stripped', async () => {
      const program = Effect.gen(function* () {
        return yield* ExpoFileSystem.ExpoCacheDir
      }).pipe(Effect.provide(ExpoFileSystem.ExpoCacheDirLive))
      const cacheDir = await Effect.runPromise(program)
      expect(cacheDir).toBe('/mock-cache')
    })
  })

  describe('ExpoFileSystem.layer composition with HttpServer.layerContext', () => {
    test('ExpoFileSystem.layer listed AFTER Server.layerContext wins (Expo impl takes effect)', async () => {
      // This pins the `Context.mergeAll` last-writer-wins ordering that
      // `ExpoContext.layer` depends on. If the noop from `Server.layerContext`
      // were winning, `writeFileString` would fail (noop's `writeFile` rejects).
      const composed = Layer.mergeAll(Server.layerContext, ExpoFileSystem.layer)
      const program = Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* fs.writeFileString('/cache/ord.html', '<p>hi</p>')
        return yield* fs.readFileString('/cache/ord.html')
      }).pipe(Effect.provide(composed))
      const result = await Effect.runPromise(program)
      expect(result).toBe('<p>hi</p>')
    })

    test('with the order reversed, the noop wins (regression guard on ordering)', async () => {
      const composed = Layer.mergeAll(ExpoFileSystem.layer, Server.layerContext)
      const error = await expectFailureCause(
        Effect.flatMap(FileSystem.FileSystem, (fs) =>
          fs.writeFileString('/cache/noop.html', 'x')
        ).pipe(Effect.provide(composed))
      )
      // The noop's `writeFileString` rejects with `SystemError NotFound`.
      expect(error).toMatchObject({ _tag: 'SystemError', reason: 'NotFound' })
    })
  })
})
