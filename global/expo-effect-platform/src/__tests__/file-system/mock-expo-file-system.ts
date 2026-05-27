/**
 * In-memory mock of the slice of `expo-file-system` that the production
 * `internal/file-system/` modules use. Each per-method test file installs
 * this module via `jest.mock('expo-file-system', () => jest.requireActual('./mock-expo-file-system'))`
 * so they share both the mock implementation and the {@link MOCK_FS} state.
 *
 * `MOCK_FS` lives at module scope so jest.mock factories (hoisted above
 * imports) can still observe writes from `beforeEach` resets and `stage`
 * helpers — `require` resolves the singleton module instance per test file.
 */

type FileEntry = { kind: 'file'; bytes: Uint8Array; modificationTime: number | null }
type DirEntry = { kind: 'dir'; size: number | null }
type FsEntry = FileEntry | DirEntry

const MOCK_FS = new Map<string, FsEntry>()

const stripScheme = (uri: string): string => uri.replace(/^file:\/\//, '')

const getEntry = (uri: string): FsEntry | undefined => MOCK_FS.get(stripScheme(uri))

class MockFile {
  readonly uri: string
  constructor(uri: string) {
    this.uri = uri
  }
  get exists(): boolean {
    return getEntry(this.uri)?.kind === 'file'
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

/** Insert an entry directly into the mock FS. Bypasses `create()` checks. */
const stage = (path: string, entry: FsEntry): void => {
  MOCK_FS.set(path, entry)
}

/** Reset the mock FS between tests. */
const resetMockFs = (): void => {
  MOCK_FS.clear()
}

// Module exports — both the jest-mock-compatible `File` / `Directory` /
// `Paths` shape and the test-side state helpers (`MOCK_FS`, `stage`,
// `resetMockFs`). Test files `jest.mock('expo-file-system', () =>
// jest.requireActual('./mock-expo-file-system'))` and then `import { MOCK_FS,
// stage } from './mock-expo-file-system'` against the same module instance.
// (Babel/jest auto-stamps `__esModule: true` on the compiled module, so no
// manual flag is needed for ES↔CJS interop.)
export {
  type FileEntry,
  type DirEntry,
  type FsEntry,
  MOCK_FS,
  stage,
  resetMockFs,
  MockFile as File,
  MockDirectory as Directory,
  Paths,
}
