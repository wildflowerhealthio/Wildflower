import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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

const readCwdPackageName = (): Option.Option<string> =>
  pipe(
    tryReadFile(join(process.cwd(), 'package.json')),
    Option.flatMap(tryJsonParse),
    Option.flatMap(decodePackageJson),
    Option.flatMapNullable((pkg) => pkg.name)
  )

/**
 * Per-package multiplier read from `FC_RISK_MAP` (a JSON object keyed by
 * package name). When the env var is unset, malformed, or omits the current
 * package, the multiplier defaults to `1.0` — i.e. no reduction.
 *
 * Resolution happens once at module load. The current package name is read
 * from `<cwd>/package.json`, which under Vitest projects mode and Jest is
 * the package being tested.
 */
const readMultiplier = (): number =>
  pipe(
    Option.fromNullable(process.env.FC_RISK_MAP),
    Option.flatMap(tryJsonParse),
    Option.flatMap(decodeRiskMap),
    Option.flatMap((map) =>
      pipe(
        Option.fromNullable(map['*']),
        Option.orElse(() =>
          pipe(
            readCwdPackageName(),
            Option.flatMapNullable((name) => map[name])
          )
        )
      )
    ),
    Option.getOrElse(() => 1.0)
  )

const multiplier = readMultiplier()

/**
 * Scale a fast-check `numRuns` value by the current package's risk multiplier.
 *
 * Floors at `min(10, base)` so a non-trivial property still runs end-to-end
 * even when the package is low risk, but a test that intentionally requests
 * fewer than 10 runs is left untouched.
 *
 * When `FC_RISK_MAP` is unset (the default, including local `vp test`),
 * this returns `base` unchanged.
 *
 * @example
 * fc.assert(prop, { numRuns: numRunsFor(100) })
 *
 * @example
 * const REFERENCE_NUM_RUNS = numRunsFor(25)
 */
export const numRunsFor = (base: number): number => {
  if (multiplier >= 1) return base
  return Math.max(Math.min(10, base), Math.floor(base * multiplier))
}
