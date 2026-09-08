import { readFileSync } from 'node:fs'
import { dirname, join, parse as parsePath, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Either, Option, pipe, Schema } from 'effect'

const RiskMap = Schema.Record({ key: Schema.String, value: Schema.Number })
const PackageJson = Schema.Struct({ name: Schema.optional(Schema.String) })

const tryJsonParse = (raw: string): Option.Option<unknown> =>
  Either.getRight(Either.try({ try: () => JSON.parse(raw) as unknown, catch: () => undefined }))

const decodeOptional = <A, I>(
  schema: Schema.Schema<A, I>
): ((value: unknown) => Option.Option<A>) => {
  const inner = Schema.decodeUnknownEither(schema)
  return (value) => Either.getRight(inner(value))
}

const decodeRiskMap = decodeOptional(RiskMap)
const decodePackageJson = decodeOptional(PackageJson)

const tryReadFile = (path: string): Option.Option<string> =>
  Either.getRight(Either.try({ try: () => readFileSync(path, 'utf8'), catch: () => undefined }))

/** Coerce an unknown to a non-empty-string `Option`. */
const nonEmptyString = (value: unknown): Option.Option<string> =>
  Option.filter(
    Option.fromNullable(value),
    (v): v is string => typeof v === 'string' && v.length > 0
  )

/**
 * Read `obj[key]` as `unknown` when `obj` is a non-null object, else
 * `undefined`. Uses `Reflect.get` so no narrowing type assertion is needed.
 */
const readProp = (obj: unknown, key: string): unknown =>
  typeof obj === 'object' && obj !== null ? (Reflect.get(obj, key) as unknown) : undefined

/** Vitest's running test file, via the worker global it always populates. */
const vitestTestPath = (): unknown =>
  // The dunder key is Vitest's, accessed dynamically so the dangling-underscore
  // identifier never appears as a property reference in our source.
  readProp(readProp(globalThis, '__vitest_worker__'), 'filepath')

/**
 * The path of the test file Vitest is executing, read from the worker global
 * rather than an imported `expect`.
 *
 * Reading from `globalThis` keeps this module free of a static dependency on
 * `vite-plus/test` (whose CommonJS entry eagerly requires the runner) and of
 * the ESM-only `import.meta` syntax, so it loads unchanged whether emitted as
 * ESM or bundled to CommonJS — the `kitchen-sink/test` barrel re-exports
 * `numRunsFor`, so this module is pulled in wherever that barrel is imported.
 *
 * Vitest populates `globalThis.__vitest_worker__.filepath` — the same source of
 * truth as `expect.getState().testPath` (verified equal) but available without
 * the `globals: true` option this repo does not set.
 *
 * Unlike the stack walk, this signal is the file *under test*, not merely the
 * first non-internal caller — so it stays correct even if a future shared
 * in-repo helper (outside this module) wraps `numRunsFor` on behalf of other
 * packages. Property reads go through `readProp`, so a missing or mis-shaped
 * global yields `none` and the caller falls back to the stack walk rather than
 * returning a bad path.
 */
const runnerTestPath = (): Option.Option<string> => nonEmptyString(vitestTestPath())

/**
 * Extract a filesystem path from a single V8 stack frame line, dropping the
 * trailing `:line:col` position and resolving a `file://` URL. Returns `none`
 * for synthetic frames such as `at new Promise (<anonymous>)`.
 *
 * Handles both `at fn (path:line:col)` and bare `at path:line:col` shapes.
 */
const frameToPath = (line: string): Option.Option<string> => {
  const trimmed = line.trim()
  if (!trimmed.startsWith('at ')) return Option.none()
  const parenStart = trimmed.indexOf('(')
  const located =
    parenStart === -1
      ? trimmed.slice('at '.length)
      : trimmed.slice(parenStart + 1, trimmed.lastIndexOf(')'))
  const withoutPosition = located.replace(/:\d+:\d+$/, '')
  if (withoutPosition.length === 0 || withoutPosition.startsWith('<')) return Option.none()
  const path = withoutPosition.startsWith('file://')
    ? Either.getOrElse(
        Either.try({ try: () => fileURLToPath(withoutPosition), catch: () => undefined }),
        () => withoutPosition
      )
    : withoutPosition
  return Option.some(path)
}

/** First frame path of a stack, or empty string if none can be read. */
const topFramePath = (stack: string | undefined): string => {
  if (stack === undefined) return ''
  for (const line of stack.split('\n')) {
    const path = Option.getOrElse(frameToPath(line), () => '')
    if (path.length > 0) return path
  }
  return ''
}

/**
 * Absolute path of this module, used to skip its own stack frames.
 *
 * Captured once at module load from the top frame of a fresh stack — that
 * frame is this very file (under a bundler, the emitted bundle). Deriving it
 * from the stack rather than the ESM-only `import.meta.url` keeps this module
 * loadable whether it is emitted as ESM or bundled to CommonJS through the
 * `kitchen-sink/test` barrel.
 */
const selfFile = topFramePath(new Error('numRunsFor self probe').stack)

/**
 * Pull the absolute path of the test file that called into this module by
 * walking the call stack.
 *
 * Used as a fallback when the runner exposes no per-test-file path global
 * (see {@link runnerTestPath}). Skips frames belonging to this module (matched
 * by its own resolved path, not a fragile substring) and to `node_modules`
 * (the test runner internals), then takes the first remaining frame.
 *
 * `numRunsFor` lives in the shared `kitchen-sink/test` bundle, so it cannot
 * learn the package under test from `process.cwd()`: under Vitest projects
 * mode the worker's cwd is the monorepo root (the runner is launched from the
 * root), not the per-package directory. The calling test file's directory does
 * sit inside the package being tested.
 */
const callerFileFromStack = (): Option.Option<string> => {
  const stack = new Error('numRunsFor caller probe').stack
  if (stack === undefined) return Option.none()
  for (const line of stack.split('\n')) {
    const path = Option.getOrElse(frameToPath(line), () => '')
    if (path.length === 0) continue
    if (selfFile.length > 0 && path === selfFile) continue
    if (path.includes(`${sep}node_modules${sep}`)) continue
    if (path.startsWith('node:')) continue
    return Option.some(path)
  }
  return Option.none()
}

/**
 * Resolve the calling test file, preferring the runner's per-test-file path
 * and falling back to a call-stack walk when no runner global is exposed.
 * See {@link runnerTestPath} and {@link callerFileFromStack}.
 */
const callerFile = (): Option.Option<string> => Option.orElse(runnerTestPath(), callerFileFromStack)

const packageNameCache = new Map<string, Option.Option<string>>()

/**
 * Walk up the directory tree from `file` to the nearest named `package.json`,
 * returning its `name`. Results are memoized per starting directory.
 */
const packageNameForFile = (file: string): Option.Option<string> => {
  let dir = dirname(file)
  const cached = packageNameCache.get(dir)
  if (cached !== undefined) return cached
  const visited: string[] = []
  const root = parsePath(dir).root
  for (;;) {
    visited.push(dir)
    const name = pipe(
      tryReadFile(join(dir, 'package.json')),
      Option.flatMap(tryJsonParse),
      Option.flatMap(decodePackageJson),
      Option.flatMapNullable((pkg) => pkg.name)
    )
    if (Option.isSome(name)) {
      for (const d of visited) packageNameCache.set(d, name)
      return name
    }
    const parent = dirname(dir)
    if (parent === dir || dir === root) break
    dir = parent
  }
  for (const d of visited) packageNameCache.set(d, Option.none())
  return Option.none()
}

const readRiskMap = (): Option.Option<Record<string, number>> =>
  pipe(
    Option.fromNullable(process.env.FC_RISK_MAP),
    Option.flatMap(tryJsonParse),
    Option.flatMap(decodeRiskMap)
  )

/**
 * Resolve the multiplier for `packageName` from a risk map. The `'*'` wildcard
 * key, when present, applies to every package and takes precedence over a
 * per-package entry. A missing package (or absent wildcard) defaults to `1.0`.
 *
 * Exported for unit testing — production callers go through {@link numRunsFor},
 * which wires the live `FC_RISK_MAP` and the resolved calling package.
 */
const multiplierFromMap = (
  map: Record<string, number>,
  packageName: Option.Option<string>
): number =>
  pipe(
    Option.fromNullable(map['*']),
    Option.orElse(() =>
      pipe(
        packageName,
        Option.flatMapNullable((name) => map[name])
      )
    ),
    Option.getOrElse(() => 1.0)
  )

/** Default floor for {@link scaleNumRuns} and {@link numRunsFor}'s `minimum`. */
const DEFAULT_MINIMUM = 10

/**
 * Scale `base` by `multiplier`, flooring at `min(minimum, base)` so a
 * non-trivial property still runs end-to-end even when the package is low risk,
 * while a test that intentionally requests fewer than `minimum` runs is left
 * untouched. A multiplier of `1.0` or higher returns `base` unchanged.
 *
 * `minimum` defaults to `10`.
 *
 * Exported for unit testing — production callers go through {@link numRunsFor}.
 */
const scaleNumRuns = (base: number, multiplier: number, minimum = DEFAULT_MINIMUM): number => {
  if (multiplier >= 1) return base
  return Math.max(Math.min(minimum, base), Math.floor(base * multiplier))
}

const currentMultiplier = (): number =>
  pipe(
    readRiskMap(),
    Option.map((map) =>
      multiplierFromMap(map, pipe(callerFile(), Option.flatMap(packageNameForFile)))
    ),
    Option.getOrElse(() => 1.0)
  )

/** Options for {@link numRunsFor}. */
interface NumRunsForOptions {
  /** The unscaled fast-check `numRuns` to request when risk scaling is off. */
  readonly base: number
  /**
   * The floor the scaled result never drops below, unless `base` itself is
   * smaller (a deliberately tiny `base` is left untouched). Defaults to `10`.
   */
  readonly minimum?: number
}

/**
 * Scale a fast-check `numRuns` value by the calling package's risk multiplier.
 *
 * Floors at `min(minimum, base)` so a non-trivial property still runs
 * end-to-end even when the package is low risk, but a test that intentionally
 * requests fewer than `minimum` runs is left untouched. `minimum` defaults to
 * `10`.
 *
 * When `FC_RISK_MAP` is unset (the default, including local `vp test`), or the
 * calling package cannot be resolved, this returns `base` unchanged.
 *
 * The multiplier is resolved per call from the calling test file's package,
 * because this helper ships in the shared `kitchen-sink/test` bundle: a single
 * worker can execute test files from more than one package, and the worker's
 * `process.cwd()` is the monorepo root under Vitest projects mode rather than
 * the package under test.
 *
 * @example
 * ```ts
 * fc.assert(prop, { numRuns: numRunsFor({ base: 100 }) })
 * ```
 *
 * @example
 * ```ts
 * const REFERENCE_NUM_RUNS = numRunsFor({ base: 25, minimum: 5 })
 * ```
 */
const numRunsFor = ({ base, minimum }: NumRunsForOptions): number =>
  scaleNumRuns(base, currentMultiplier(), minimum)

// `multiplierFromMap` and `scaleNumRuns` are exported for unit testing only;
// the public `kitchen-sink/test` entry (src/test/index.ts) re-exports just
// `numRunsFor`.
export type { NumRunsForOptions }
export { multiplierFromMap, numRunsFor, scaleNumRuns }
